/**
 * PromptQlAdapter — maps gateway operations to the VERIFIED PromptQL MCP tools.
 *
 * PromptQL's product concept is a "bot"; the MCP wire still uses `thread_id`
 * (compatibility-first naming migration). We say "bot" in our domain and keep
 * `thread_id` on the wire.
 *
 * Flow (verified live):
 *   ask_promptql({query, thread_id?, room_name?})
 *     -> { thread_id, thread_event_id }
 *   get_latest_promptql_thread_response({thread_id, thread_event_id})  [blocking]
 *     -> { status, message, approvals[] }
 *        status: completed | analyzing (re-call) | waiting_approval
 *
 * Approvals are auto-declined in this gateway (respond_to_promptql_approval)
 * and the caller notifies the shopper — the gateway never auto-approves a
 * sensitive action on behalf of an unauthenticated WhatsApp sender.
 */

import { z } from "zod";
import type { Config } from "../config.ts";
import { rootLogger, type Logger } from "../logger.ts";
import { McpSession, McpError } from "./mcpClient.ts";

const TOOL_ASK = "ask_promptql";
const TOOL_WAIT = "get_latest_promptql_thread_response";
const TOOL_RESPOND_APPROVAL = "respond_to_promptql_approval";

export interface AskResult {
  threadId: string;
  threadEventId: string | null;
}

const PromptQlFileInputSchema = z
  .object({
    file_name: z.string().min(1).max(255),
    mime_type: z.string().min(1).max(255),
    content_base64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

const PromptQlFilesSchema = z.array(PromptQlFileInputSchema).max(1);

export type PromptQlFileInput = z.infer<typeof PromptQlFileInputSchema>;

export type BotResponse =
  | { status: "completed"; message: string }
  | { status: "declined_approval"; message: string }
  | { status: "failed"; message: string };

export interface AdapterDeps {
  config: Config;
  /** Resolve a shopper's MCP-scoped token at call time. Never cached in cleartext. */
  getToken: (shopperId: string) => string | null;
  /** Optional structured logger; defaults to the process root logger. */
  log?: Logger;
}

export class PromptQlAdapter {
  private readonly sessions = new Map<string, McpSession>();
  private readonly log: Logger;

  constructor(private readonly deps: AdapterDeps) {
    this.log = deps.log ?? rootLogger.child({ component: "promptql" });
  }

  private session(shopperId: string): McpSession {
    const cached = this.sessions.get(shopperId);
    if (cached) return cached;
    const token = this.deps.getToken(shopperId);
    if (!token) {
      throw new McpError(`no active MCP credential for shopper ${shopperId}`, "protocol");
    }
    const mcp = this.deps.config.mcp;
    if (!mcp.endpoint) throw new McpError("PROMPTQL MCP endpoint not configured", "protocol");
    const session = new McpSession(
      {
        endpoint: mcp.endpoint,
        authScheme: mcp.authScheme,
        protocolVersion: mcp.protocolVersion,
        timeoutMs: mcp.timeoutMs,
        maxRetries: mcp.maxRetries,
      },
      token,
    );
    this.sessions.set(shopperId, session);
    return session;
  }

  /** Drop a shopper's cached session (after credential rotation/revoke). */
  invalidate(shopperId: string): void {
    this.sessions.delete(shopperId);
  }

  /** Discovery: list the tools this shopper's session can see. */
  async listTools(shopperId: string) {
    return this.session(shopperId).listTools();
  }

  /**
   * Start or continue a bot (thread). Pass `threadId` to continue an existing
   * conversation, omit for a new one. `roomName`, when set, routes/creates the
   * thread in that room (must satisfy the PromptQL room_name pattern).
   */
  async ask(
    shopperId: string,
    input: {
      query: string;
      threadId?: string | null;
      roomName?: string | null;
      files?: PromptQlFileInput[];
    },
  ): Promise<AskResult> {
    const args: Record<string, unknown> = { query: input.query };
    if (input.threadId) args.thread_id = input.threadId;
    if (input.roomName) args.room_name = input.roomName;
    if (input.files?.length) {
      // Validate the new outbound MCP I/O boundary before transmission.
      args.files = PromptQlFilesSchema.parse(input.files);
    }

    const result = await this.session(shopperId).callTool(TOOL_ASK, args);
    const sc = (result.structured ?? {}) as {
      thread_id?: string;
      thread_event_id?: string;
      status?: string;
    };
    if (!sc.thread_id) {
      throw new McpError(`${TOOL_ASK} returned no thread_id: ${result.text}`, "protocol");
    }
    return { threadId: sc.thread_id, threadEventId: sc.thread_event_id ?? null };
  }

  /**
   * Blocking wait for the bot's response. Re-calls on `analyzing` (still running
   * or the long-poll timed out) until the deadline. On `waiting_approval`,
   * auto-declines every pending approval and returns a declined_approval result.
   */
  async waitForResponse(
    shopperId: string,
    ask: AskResult,
    deadlineMs: number,
  ): Promise<BotResponse> {
    const session = this.session(shopperId);
    const waitArgs: Record<string, unknown> = { thread_id: ask.threadId };
    if (ask.threadEventId) waitArgs.thread_event_id = ask.threadEventId;

    while (Date.now() < deadlineMs) {
      const result = await session.callTool(TOOL_WAIT, waitArgs);
      const sc = (result.structured ?? {}) as {
        status?: string;
        message?: string;
        approvals?: Array<{ approval_id?: string; message?: string; description?: string }>;
      };
      const status = sc.status ?? "";
      const message = sc.message ?? result.text ?? "";

      if (status === "completed" || status === "success") {
        return { status: "completed", message };
      }
      if (status === "waiting_approval") {
        await this.declineAll(session, sc.approvals ?? []);
        return {
          status: "declined_approval",
          message:
            "This request needs approval for a sensitive action. It was not auto-approved — please review it in the PromptQL console.",
        };
      }
      if (status === "failed" || status === "error" || status === "cancelled") {
        return { status: "failed", message: message || `PromptQL run ${status}` };
      }
      // analyzing / running / anything else → keep waiting; the tool itself
      // long-polls, so we loop immediately (no extra sleep needed).
    }
    return { status: "failed", message: "PromptQL did not respond before the deadline." };
  }

  /** Auto-decline every pending approval (gateway policy). */
  private async declineAll(
    session: McpSession,
    approvals: Array<{ approval_id?: string }>,
  ): Promise<void> {
    for (const a of approvals) {
      if (!a.approval_id) continue;
      try {
        await session.callTool(TOOL_RESPOND_APPROVAL, {
          approval_id: a.approval_id,
          decision: "decline",
        });
      } catch (err) {
        this.log.warn("failed to decline approval", { approvalId: a.approval_id, err });
      }
    }
  }
}
