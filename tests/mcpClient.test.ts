/**
 * MCP client tests against the VERIFIED live behavior: SSE bodies, sessionless
 * operation (no Mcp-Session-Id sent), notifications/initialized -> 202,
 * isError-as-failure, and 404 -> reinitialize.
 *
 * fetch is stubbed with a scripted queue of responses.
 */

import { test, expect, afterEach } from "bun:test";
import { McpSession, McpError } from "../src/promptql/mcpClient.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  sse?: string;
}

/** All PromptQL responses are SSE; this helper wraps a JSON-RPC object as SSE. */
function sseOf(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

function scriptFetch(queue: Scripted[]): { calls: Request[] } {
  const calls: Request[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push(new Request(input, init));
    const next = queue.shift();
    if (!next) throw new Error("no scripted response");
    const headers = new Headers(next.headers ?? {});
    if (next.sse !== undefined) {
      headers.set("content-type", "text/event-stream");
      return new Response(next.sse, { status: next.status ?? 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers,
    });
  }) as typeof fetch;
  return { calls };
}

const OPTS = {
  endpoint: "https://x.test/mcp-server/mcp?project-name=p",
  authScheme: "pat",
  protocolVersion: "2025-03-26",
  timeoutMs: 2_000,
  maxRetries: 1,
};

test("initialize over SSE, no session id sent on later requests (sessionless)", async () => {
  const { calls } = scriptFetch([
    { sse: sseOf({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }) }, // initialize
    { status: 202 }, // notifications/initialized
    { sse: sseOf({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ask_promptql" }] } }) },
  ]);
  const s = new McpSession(OPTS, "token");
  const tools = await s.listTools();
  expect(tools.map((t) => t.name)).toEqual(["ask_promptql"]);
  // No server session id was issued, so none is echoed; auth scheme is correct.
  const last = calls[2];
  expect(last.headers.get("Mcp-Session-Id")).toBeNull();
  expect(last.headers.get("authorization")).toBe("pat token");
  // The Accept header must advertise SSE.
  expect(last.headers.get("accept")).toContain("text/event-stream");
});

test("notifications/initialized returns 202 and is tolerated", async () => {
  scriptFetch([
    { sse: sseOf({ jsonrpc: "2.0", id: 1, result: {} }) },
    { status: 202 },
    { sse: sseOf({ jsonrpc: "2.0", id: 2, result: { tools: [] } }) },
  ]);
  const s = new McpSession(OPTS, "token");
  expect(await s.listTools()).toEqual([]);
});

test("result.isError=true is a tool failure even on HTTP 200", async () => {
  scriptFetch([
    { sse: sseOf({ jsonrpc: "2.0", id: 1, result: {} }) },
    { status: 202 },
    {
      sse: sseOf({
        jsonrpc: "2.0",
        id: 2,
        result: { isError: true, content: [{ type: "text", text: "boom" }] },
      }),
    },
  ]);
  const s = new McpSession(OPTS, "token");
  let thrown: unknown;
  try {
    await s.callTool("ask_promptql", {});
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(McpError);
});

test("structuredContent is surfaced from a tools/call result", async () => {
  scriptFetch([
    { sse: sseOf({ jsonrpc: "2.0", id: 1, result: {} }) },
    { status: 202 },
    {
      sse: sseOf({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "{\"thread_id\":\"t1\"}" }],
          structuredContent: { thread_id: "t1", thread_event_id: "e1", status: "success" },
        },
      }),
    },
  ]);
  const s = new McpSession(OPTS, "token");
  const res = await s.callTool("ask_promptql", { query: "hi" });
  expect((res.structured as any).thread_id).toBe("t1");
});

test("HTTP 404 triggers one reinitialize then retry", async () => {
  scriptFetch([
    { sse: sseOf({ jsonrpc: "2.0", id: 1, result: {} }) }, // initialize
    { status: 202 },
    { status: 404, body: {} }, // tools/list -> expired
    { sse: sseOf({ jsonrpc: "2.0", id: 3, result: {} }) }, // reinitialize
    { status: 202 },
    { sse: sseOf({ jsonrpc: "2.0", id: 4, result: { tools: [] } }) }, // retry ok
  ]);
  const s = new McpSession(OPTS, "token");
  expect(await s.listTools()).toEqual([]);
});
