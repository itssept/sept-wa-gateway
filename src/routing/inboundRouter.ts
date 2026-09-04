/**
 * InboundRouter — inbound half of the message flow.
 *
 *  1. Resolve the chat jid to exactly one enabled shopper (+ active credential).
 *  2. Reject unknown/disabled/unmapped/credential-less senders — SILENT drop +
 *     audit log, no WhatsApp reply (respects anti-ban / never-unsolicited).
 *  3. Claim outbound idempotency on the inbound message id (replay-safe).
 *  4. Look up the chat's existing PromptQL bot (thread) for continuity; start a
 *     new one on the first message (per-shopper room when configured).
 *  5. ask_promptql under the shopper's service-account identity.
 *  6. Persist the bot handle + a durable workflow correlation, then hand off to
 *     the OutboundDispatcher (blocking wait -> paced send).
 *
 * Every inbound message is mirrored (forward policy = mirror-every).
 */

import type { InboundMessage } from "../whatsapp/socket.ts";
import type { ShopperResolver } from "./resolver.ts";
import { PromptQlAdapter, shopperRoomName } from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { ChatBotRepo } from "../storage/chatBotRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { AuditLog } from "../storage/auditLog.ts";
import type { OutboundDispatcher } from "./outboundDispatcher.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import { maskJid } from "../util.ts";

export class InboundRouter {
  constructor(
    private readonly config: Config,
    private readonly resolver: ShopperResolver,
    private readonly adapter: PromptQlAdapter,
    private readonly workflows: McpWorkflowRepo,
    private readonly chatBots: ChatBotRepo,
    private readonly outboundLog: OutboundLog,
    private readonly dispatcher: OutboundDispatcher,
    private readonly audit: AuditLog,
    private readonly log: Logger,
  ) {}

  /** Handle one captured inbound message. Never throws to the caller. */
  async handle(msg: InboundMessage): Promise<void> {
    const corrId = msg.messageId;
    // corrId is the WhatsApp message id (opaque, not PII); bind it for the flow.
    const log = this.log.child({ corrId, chatJid: maskJid(msg.chatJid) });
    try {
      if (!msg.text.trim()) return; // nothing to forward

      const res = this.resolver.resolve(msg.connectionId, msg.chatJid);
      if (!res.ok) {
        this.audit.record("inbound.rejected", {
          subjectType: "connection",
          subjectId: msg.connectionId,
          detail: { chatJid: maskJid(msg.chatJid), reason: res.reason },
        });
        log.info("inbound dropped", { reason: res.reason });
        return;
      }
      const shopper = res.shopper;

      const claim = this.outboundLog.claim(msg.connectionId, msg.messageId);
      if (claim.status === "already_sent") {
        log.info("inbound deduped (already answered)");
        return;
      }
      if (claim.status === "in_flight") {
        log.info("inbound skipped (in flight)");
        return;
      }

      // Continue the chat's existing bot (thread) when we have one.
      const existing = this.chatBots.get(msg.connectionId, msg.chatJid);
      const roomName = this.config.mcp.useShopperRoom ? shopperRoomName(shopper.id) : null;

      log.info("inbound ask", {
        shopperId: shopper.id,
        continuity: existing ? "continue" : "new",
      });

      const ask = await this.adapter.ask(shopper.id, {
        query: msg.text,
        threadId: existing?.threadId ?? null,
        roomName: existing ? null : roomName,
      });

      // Persist the bot handle for continuity, and a durable correlation.
      this.chatBots.upsert({
        connectionId: msg.connectionId,
        chatJid: msg.chatJid,
        shopperId: shopper.id,
        threadId: ask.threadId,
        roomName: existing?.roomName ?? roomName,
      });
      const workflow = this.workflows.create({
        connectionId: msg.connectionId,
        chatJid: msg.chatJid,
        shopperId: shopper.id,
        inboundMessageId: msg.messageId,
        remoteRef: ask.threadId,
      });

      await this.dispatcher.dispatch({
        workflowId: workflow.id,
        connectionId: msg.connectionId,
        chatJid: msg.chatJid,
        shopperId: shopper.id,
        idempotencyKey: msg.messageId,
        claimToken: claim.token,
        threadId: ask.threadId,
        threadEventId: ask.threadEventId,
      });
    } catch (err) {
      log.error("inbound error", { err });
    }
  }
}
