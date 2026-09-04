/**
 * OutboundDispatcher — outbound half of the message flow.
 *
 *  1. Block on get_latest_promptql_thread_response (re-called on `analyzing`
 *     until a bounded deadline) for the bot's answer.
 *  2. On completed -> that message. On declined_approval -> a notice that the
 *     action needs console approval (we auto-declined). On failed -> mark failed.
 *  3. Resolve the originating chat from the durable dispatch record.
 *  4. Send through Baileys via the anti-ban queue.
 *  5. Record delivery success/failure against the outbound idempotency log using
 *     the claim token (retry-safe, fenced against a lost claim).
 */

import type { PromptQlAdapter } from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { WhatsAppConnection } from "../whatsapp/socket.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import { maskJid } from "../util.ts";

export interface DispatchInput {
  workflowId: string;
  connectionId: string;
  chatJid: string;
  shopperId: string;
  idempotencyKey: string;
  claimToken: string;
  threadId: string;
  threadEventId: string | null;
}

export class OutboundDispatcher {
  constructor(
    private readonly adapter: PromptQlAdapter,
    private readonly workflows: McpWorkflowRepo,
    private readonly outboundLog: OutboundLog,
    private readonly connection: WhatsAppConnection,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  async dispatch(input: DispatchInput): Promise<void> {
    const deadline = Date.now() + this.config.mcp.responseMaxMs;

    let answer: string | null = null;
    try {
      const res = await this.adapter.waitForResponse(
        input.shopperId,
        { threadId: input.threadId, threadEventId: input.threadEventId },
        deadline,
      );
      if (res.status === "failed") {
        this.fail(input, res.message);
        return;
      }
      // completed or declined_approval both produce a message to send back.
      answer = res.message;
    } catch (err) {
      this.fail(input, `PromptQL error: ${String(err)}`);
      return;
    }

    if (!answer || answer.trim() === "") {
      this.fail(input, "empty response");
      return;
    }

    this.workflows.markDone(input.workflowId, answer);
    try {
      const ref = await this.connection.sendText(input.chatJid, answer);
      const ok = this.outboundLog.markSent(
        input.connectionId,
        input.idempotencyKey,
        input.claimToken,
        { chatJid: input.chatJid, messageRef: ref },
      );
      const log = this.log.child({ corrId: input.idempotencyKey, chatJid: maskJid(input.chatJid) });
      if (ok) log.info("outbound sent", { messageRef: ref });
      else log.warn("outbound claim lost");
    } catch (err) {
      this.outboundLog.markFailed(input.connectionId, input.idempotencyKey, input.claimToken);
      this.log.error("outbound send failed", {
        corrId: input.idempotencyKey,
        chatJid: maskJid(input.chatJid),
        err,
      });
    }
  }

  private fail(input: DispatchInput, reason: string): void {
    this.workflows.markFailed(input.workflowId);
    this.outboundLog.markFailed(input.connectionId, input.idempotencyKey, input.claimToken);
    this.log.warn("outbound no result", {
      corrId: input.idempotencyKey,
      chatJid: maskJid(input.chatJid),
      workflowId: input.workflowId,
      reason,
    });
  }
}
