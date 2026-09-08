/**
 * PromptQL MCP client — JSON-RPC 2.0 over Streamable HTTP.
 *
 * Verified against the live PromptQL MCP server (see README §PromptQL MCP):
 *   - Endpoint is `<base>/mcp-server/mcp?project-name=<project>` (project is a
 *     QUERY PARAM). The full URL is configuration; nothing is hardcoded.
 *   - Auth: `Authorization: <scheme> <token>` (scheme configurable, default `pat`).
 *   - EVERY response is `text/event-stream` (SSE), including `initialize`.
 *   - The server is SESSIONLESS: it issues no `Mcp-Session-Id`. We must NOT
 *     invent one (sending a bogus id returns HTTP 500). If a future deployment
 *     does return one, we capture and echo it.
 *   - `notifications/initialized` returns HTTP 202 (no body).
 *
 * The client: initializes once, uses a fresh JSON-RPC id per request, parses
 * SSE + JSON bodies, treats `result.isError: true` as failure even on HTTP 200,
 * applies a timeout + bounded transient retries, and reinitializes on HTTP 404.
 *
 * The per-request token is the resolved shopper's MCP-scoped service-account
 * token and is NEVER logged.
 */

import { z } from "zod";

// Match the server's default 10 MiB request budget, including base64 overhead.
// The raw download cap is separate; query/metadata can still exceed this limit.
const McpRequestBodySchema = z.string().refine(
  (body) => Buffer.byteLength(body, "utf8") <= 10 * 1024 * 1024,
  "MCP request exceeds the 10 MiB limit",
);

export interface McpClientOptions {
  endpoint: string;
  authScheme: string; // e.g. "pat"
  protocolVersion: string; // e.g. "2025-03-26"
  timeoutMs: number;
  maxRetries: number;
  clientName?: string;
  clientVersion?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCallResult {
  isError: boolean;
  /** Concatenated text parts of result.content[].text. */
  text: string;
  /** result.structuredContent when present. */
  structured: unknown;
  /** The raw JSON-RPC result object. */
  raw: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: "transport" | "protocol" | "tool" | "session_expired",
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * One MCP session bound to one authorization token. Not shared across shoppers —
 * each shopper gets its own McpSession so PromptQL attributes work to the right
 * service account. "Session" here is a client-side object; the server itself is
 * stateless, so this mostly caches the initialize handshake.
 */
export class McpSession {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly opts: McpClientOptions,
    private readonly token: string,
  ) {}

  private authHeader(): string {
    return `${this.opts.authScheme} ${this.token}`;
  }

  private newId(): number {
    return this.nextId++;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const body = {
      jsonrpc: "2.0" as const,
      id: this.newId(),
      method: "initialize",
      params: {
        protocolVersion: this.opts.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: this.opts.clientName ?? "SEPT WhatsApp Gateway",
          version: this.opts.clientVersion ?? "0.1.0",
        },
      },
    };
    const { response, json } = await this.post(body, {});
    if (json?.error) {
      throw new McpError(`initialize failed: ${json.error.message}`, "protocol");
    }
    // Capture Mcp-Session-Id if the server issues one (this deployment does not).
    const sid = response.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;

    // notifications/initialized — a notification (no id), server replies 202.
    await this.post({ jsonrpc: "2.0" as const, method: "notifications/initialized", params: {} }, {
      notification: true,
    });
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: McpTool[] })?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  /** Invoke a tool. Throws McpError('tool') when result.isError is true. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.ensureInitialized();
    const result = await this.request("tools/call", { name, arguments: args });
    const parsed = parseToolResult(result);
    if (parsed.isError) {
      throw new McpError(`tool ${name} returned isError: ${parsed.text}`, "tool");
    }
    return parsed;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const body = { jsonrpc: "2.0" as const, id: this.newId(), method, params };
        const { json } = await this.post(body, {});
        if (json?.error) {
          throw new McpError(
            `${method} failed: ${json.error.message} (code ${json.error.code})`,
            "protocol",
          );
        }
        return json?.result;
      } catch (err) {
        lastErr = err;
        if (err instanceof McpError && err.kind === "session_expired") {
          this.initialized = false;
          this.sessionId = null;
          await this.initialize();
          continue;
        }
        if (err instanceof McpError && err.kind !== "transport") throw err;
        if (attempt < this.opts.maxRetries) {
          await sleep(Math.min(500 * 2 ** attempt, 4_000));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new McpError(String(lastErr), "transport");
  }

  /** Low-level POST. Handles JSON + SSE bodies, optional session header, timeout. */
  private async post(
    body: unknown,
    opts: { notification?: boolean },
  ): Promise<{ response: Response; json: JsonRpcResponse | null }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: this.authHeader(),
    };
    // Only send a session id if the server actually gave us one.
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const serialized = McpRequestBodySchema.safeParse(JSON.stringify(body));
    if (!serialized.success) {
      throw new McpError("MCP request exceeds the 10 MiB limit", "protocol");
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.opts.endpoint, {
        method: "POST",
        headers,
        body: serialized.data,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new McpError(`transport error: ${String(err)}`, "transport");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new McpError("session expired (HTTP 404)", "session_expired");
    }
    if (opts.notification) {
      // 202 Accepted (or 200) with no meaningful body.
      return { response, json: null };
    }
    if (response.status >= 500) {
      const t = await safeText(response);
      throw new McpError(`server error HTTP ${response.status}: ${t}`, "transport");
    }
    if (!response.ok) {
      const t = await safeText(response);
      throw new McpError(`HTTP ${response.status}: ${t}`, "protocol");
    }

    const json = await parseBody(response);
    return { response, json };
  }
}

/** Parse a JSON or SSE response body into a single JSON-RPC response. */
async function parseBody(response: Response): Promise<JsonRpcResponse | null> {
  const ctype = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (ctype.includes("text/event-stream")) return parseSse(text);
  if (!text) return null;
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch (err) {
    throw new McpError(`invalid JSON response: ${String(err)}`, "protocol");
  }
}

/**
 * Parse an SSE body. Collect `data:` lines per event and return the LAST JSON
 * object that carries a JSON-RPC result/error (earlier events may be progress).
 */
function parseSse(text: string): JsonRpcResponse | null {
  const events = text.split(/\n\n/);
  let last: JsonRpcResponse | null = null;
  for (const ev of events) {
    const dataLines = ev
      .split(/\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    try {
      const obj = JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
    } catch {
      /* skip non-JSON events */
    }
  }
  return last;
}

/** Extract isError / text / structuredContent from a tools/call result. */
function parseToolResult(result: unknown): ToolCallResult {
  const r = (result ?? {}) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const text = Array.isArray(r.content)
    ? r.content
        .filter((c) => typeof c?.text === "string")
        .map((c) => c.text)
        .join("\n")
    : "";
  return { isError: r.isError === true, text, structured: r.structuredContent, raw: result };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
