/**
 * InboundRouter — inbound half of the message flow.
 *
 *  1. Resolve the chat jid to exactly one enabled shopper (+ active credential).
 *  2. Reject unknown/disabled/unmapped/credential-less senders — SILENT drop +
 *     audit log, no WhatsApp reply (respects anti-ban / never-unsolicited).
 *  3. Claim outbound idempotency on the inbound message id (replay-safe).
 *  4. Look up the chat's existing PromptQL bot (thread) for continuity; start a
 *     new one on the first message in the shopper's caller-owned room.
 *  5. ask_promptql under the shopper's service-account identity.
 *  6. Persist the bot handle + a durable workflow correlation, then hand off to
 *     the OutboundDispatcher (blocking wait -> paced send).
 *
 * Every inbound message is mirrored (forward policy = mirror-every).
 */

import type { InboundMessage } from "../whatsapp/socket.ts";
import type { ShopperResolver } from "./resolver.ts";
import {
  PromptQlAdapter,
  type PromptQlFileInput,
} from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { ChatBotRepo } from "../storage/chatBotRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { AuditLog } from "../storage/auditLog.ts";
import type { OutboundDispatcher } from "./outboundDispatcher.ts";
import type { Logger } from "../logger.ts";
import { maskJid } from "../util.ts";

export class InboundRouter {
  constructor(
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
      // Ignore empty text/unknown messages. Media-only messages remain routable.
      if (!promptQlQuery(msg)) return;

      const res = this.resolver.resolve(msg.connectionId, msg.chatJid, msg.senderPhoneE164);
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
      // Room is caller-owned: use the shopper's stored room_name verbatim.
      const roomName = shopper.roomName;

      log.info("inbound ask", {
        shopperId: shopper.id,
        continuity: existing ? "continue" : "new",
        resolvedVia: res.via, // "mapping" (admin-set) or "sender" (auto by phone)
      });

      const files = this.loadPromptQlFiles(msg);
      const query = promptQlQuery(msg, files.length > 0);
      if (!query) return;

      let ask;
      try {
        // McpSession retries transient transport failures with this same
        // in-memory payload. No disk/S3 retry copy is created.
        ask = await this.adapter.ask(shopper.id, {
          query,
          threadId: existing?.threadId ?? null,
          roomName: existing ? null : roomName,
          files,
        });
      } finally {
        // Drop references promptly after ask_promptql accepts or exhausts its
        // retries. The bytes are intentionally unrecoverable after a crash.
        msg.media = null;
        files.length = 0;
      }

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

      // Response polling and WhatsApp delivery can take minutes. Start that
      // durable phase in the background so the inbound media queue is held only
      // until PromptQL has accepted the attachment.
      void this.dispatcher
        .dispatch({
          workflowId: workflow.id,
          connectionId: msg.connectionId,
          chatJid: msg.chatJid,
          shopperId: shopper.id,
          idempotencyKey: msg.messageId,
          claimToken: claim.token,
          threadId: ask.threadId,
          threadEventId: ask.threadEventId,
        })
        .catch((err) => {
          log.error("outbound dispatch failed", { err });
        });
    } catch (err) {
      log.error("inbound error", { err });
    }
  }

  private loadPromptQlFiles(msg: InboundMessage): PromptQlFileInput[] {
    if (msg.mediaStatus !== "ready" || !msg.media) return [];
    return [
      {
        file_name: mediaFileName(msg.messageId, msg.msgType, msg.media.mime ?? null),
        mime_type: msg.media.mime ?? "application/octet-stream",
        content_base64: msg.media.bytes.toString("base64"),
      },
    ];
  }
}

export function promptQlQuery(
  msg: InboundMessage,
  attachedToPromptQl = false,
): string | null {
  const text = msg.text.trim();
  if (msg.msgType === "text" || msg.msgType === "unknown") {
    return text || null;
  }

  const availability = attachedToPromptQl
    ? "included as a PromptQL file attachment"
    : `unavailable (${msg.mediaStatus})`;
  const descriptor =
    `[WhatsApp ${msg.msgType} attached; media is ${availability}; ` +
    `chat_id=${msg.chatJid}; message_id=${msg.messageId}]`;
  return text ? `${text}\n\n${descriptor}` : descriptor;
}

export function mediaFileName(
  messageId: string,
  messageType: string,
  mime: string | null,
): string {
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  const safeType = messageType.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
  };
  const normalizedMime = mime?.split(";")[0]?.trim() ?? "";
  return `whatsapp-${safeType || "media"}-${safeId || "message"}${extensions[normalizedMime] ?? ""}`;
}
