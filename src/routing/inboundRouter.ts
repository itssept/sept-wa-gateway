/**
 * Group activation is opt-in by a registered shopper's tag, with no backfill.
 * Once active, context-only messages are relayed without running the bot.
 * DMs keep their existing routing and transient file delivery.
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
import { groupQuery, senderLabel, GROUP_INSTRUCTION } from "./groupRelay.ts";
import { nowIso } from "../util.ts";
import type { SelfMembershipEvent } from "../whatsapp/groupEvents.ts";
import { maskJid } from "../util.ts";

export class InboundRouter {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly membership = new Map<string, { epoch: number; ts: string }>();

  private key(connectionId: string, chatJid: string): string {
    return JSON.stringify([connectionId, chatJid]);
  }

  /** Immediate local pause, also fences a tag already waiting on MCP. */
  onSelfMembership(event: SelfMembershipEvent): void {
    const key = this.key(event.connectionId, event.groupJid);
    this.membership.set(key, { epoch: (this.membership.get(key)?.epoch ?? 0) + 1, ts: nowIso() });
    this.chatBots.pauseRelay(event.connectionId, event.groupJid);
  }

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
  handle(msg: InboundMessage): Promise<void> {
    const key = this.key(msg.connectionId, msg.chatJid);
    const epoch = this.membership.get(key)?.epoch ?? 0;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.process(msg, key, epoch));
    this.chains.set(key, run);
    void run.finally(() => {
      if (this.chains.get(key) === run) this.chains.delete(key);
    }).catch(() => undefined);
    return run;
  }

  private async process(msg: InboundMessage, key: string, epoch: number): Promise<void> {
    const corrId = msg.messageId;
    // corrId is the WhatsApp message id (opaque, not PII); bind it for the flow.
    const log = this.log.child({ corrId, chatJid: maskJid(msg.chatJid) });
    let claimToken: string | null = null;
    try {
      if (msg.fromMe && (!msg.isGroup ||
        this.outboundLog.isGatewayMessage(msg.connectionId, msg.chatJid, msg.messageId))) return;
      if (msg.isGroup && epoch !== (this.membership.get(key)?.epoch ?? 0)) return;
      // Ignore empty text/unknown messages. Media-only messages remain routable.
      if (!promptQlQuery(msg)) return;

      const existing = this.chatBots.get(msg.connectionId, msg.chatJid);
      const sender = this.resolver.resolve(msg.connectionId, msg.chatJid, msg.senderPhoneE164);
      const trigger = !msg.fromMe && (!msg.isGroup || msg.mentionsSelf) && sender.ok;
      const relay = msg.isGroup && !trigger;
      if (relay && (!existing || existing.relayPausedAt !== null)) return;

      const res = relay
        ? this.resolver.resolveShopper(existing!.shopperId)
        : sender;
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

      claimToken = claim.token;
      // Room is caller-owned: use the shopper's stored room_name verbatim.
      const roomName = shopper.roomName;

      log.info("inbound ask", {
        shopperId: shopper.id,
        continuity: existing ? "continue" : "new",
        resolvedVia: res.via, // "mapping" (admin-set) or "sender" (auto by phone)
      });

      const files = msg.isGroup ? [] : this.loadPromptQlFiles(msg);
      const query = msg.isGroup
        ? groupQuery(msg, senderLabel(msg, sender.ok ? sender.shopper : undefined))
        : promptQlQuery(msg, files.length > 0);
      if (!query) return;

      let ask;
      try {
        // McpSession retries transient transport failures with this same
        // in-memory payload. No persistent retry copy is created.
        ask = await this.adapter.ask(shopper.id, {
          query,
          threadId: existing?.threadId ?? null,
          roomName: existing ? null : roomName,
          files,
          ...(msg.isGroup ? {
            agentResponse: relay ? "force_skip" as const : "force_respond" as const,
            ...(!relay ? { systemInstruction: GROUP_INSTRUCTION } : {}),
          } : {}),
        });
      } finally {
        // Drop references promptly after ask_promptql accepts or exhausts its
        // retries. The bytes are intentionally unrecoverable after a crash.
        msg.media = null;
        files.length = 0;
      }

      if (relay) {
        this.outboundLog.markRelayed(msg.connectionId, msg.messageId, claim.token, msg.chatJid);
        log.info("group context relayed");
        return; // force_skip never creates a workflow or waits for a response.
      }

      // A successful tag resumes relay, unless membership changed during ask.
      const latestMembership = this.membership.get(key);
      this.chatBots.upsert({
        connectionId: msg.connectionId,
        chatJid: msg.chatJid,
        shopperId: shopper.id,
        threadId: ask.threadId,
        roomName: existing?.roomName ?? roomName,
        relayPausedAt: msg.isGroup && latestMembership && latestMembership.epoch !== epoch
          ? latestMembership.ts : null,
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
      if (claimToken) this.outboundLog.markFailed(msg.connectionId, msg.messageId, claimToken);
      log.error("inbound error", { err });
    } finally {
      msg.media = null;
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
