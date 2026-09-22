/** Per-chat submission FIFO. Identity is per post; bot ownership is permanent. */
import { z } from "zod";
import type { InboundMessage, HistoryBatchEvent, RoutingGroup } from "../whatsapp/socket.ts";
import type { SelfMembershipEvent } from "../whatsapp/groupEvents.ts";
import type { ShopperResolver } from "./resolver.ts";
import {
  AskSubmissionError, promptQlFileFromMedia,
  type PromptQlAdapter, type PromptQlFileInput, type PostingIdentity, type AskResult,
} from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { ChatBotRepo, ChatBot } from "../storage/chatBotRepo.ts";
import type { MessageStore, StoredHistoryMessage } from "../storage/messageStore.ts";
import type { GatewaySettingsRepo } from "../storage/gatewaySettingsRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { AuditLog } from "../storage/auditLog.ts";
import type { OutboundDispatcher } from "./outboundDispatcher.ts";
import type { Logger } from "../logger.ts";
import type { Shopper } from "../domain/types.ts";
import { clientQuery, mediaLabel, paPrompt } from "./groupRelay.ts";
import { maskJid, phoneE164FromJid, nowIso } from "../util.ts";

interface RoutingDeps {
  settings: GatewaySettingsRepo;
  messages: MessageStore;
  getGroup: (groupJid: string) => Promise<RoutingGroup | null>;
  prepareHistory: (row: StoredHistoryMessage) => Promise<InboundMessage | null>;
  /** Add a WhatsApp reaction to an inbound message. Best-effort; optional so
   *  tests and non-reacting wirings can omit it. */
  reactToMessage?: (msg: InboundMessage, emoji: string) => Promise<void>;
  /** Relay ownerless (unregistered DM / unqualified group) chats to the common
   *  room. Off by default: such chats are dropped (audited), never relayed,
   *  until an enabled registered shopper qualifies them. */
  relayUnregisteredChats?: boolean;
}

/** Shown on a relayed message once the agent is asked to respond (force_respond),
 *  so users know a reply is coming. */
const AGENT_ACK_EMOJI = "👀";
interface Destination {
  owner: Shopper | null;
  ownerId: string | null;
  roomName: string;
  qualified: boolean;
}
const CLIENT: PostingIdentity = { role: "client" };
const MembershipSchema = z.object({
  connectionId: z.string().min(1), groupJid: z.string().regex(/@g\.us$/),
  addedByJid: z.string().nullish(),
});

export class InboundRouter {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly resolver: ShopperResolver,
    private readonly adapter: PromptQlAdapter,
    private readonly workflows: McpWorkflowRepo,
    private readonly chatBots: ChatBotRepo,
    private readonly outboundLog: OutboundLog,
    private readonly dispatcher: OutboundDispatcher,
    private readonly audit: AuditLog,
    private readonly log: Logger,
    private readonly deps: RoutingDeps,
  ) {}

  private key(connectionId: string, chatJid: string): string {
    return JSON.stringify([connectionId, chatJid]);
  }

  onSelfMembership(event: SelfMembershipEvent, action: "add" | "remove" = "remove"): void {
    const value = MembershipSchema.parse(event);
    const key = this.key(value.connectionId, value.groupJid);
    if (action !== "add" || this.chatBots.membership(value.connectionId, value.groupJid)?.present !== 1) {
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    }
    this.chatBots.setMembership(value.connectionId, value.groupJid, action === "add", value.addedByJid);
  }

  private enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.chains.set(key, run);
    void run.finally(() => {
      if (this.chains.get(key) === run) this.chains.delete(key);
    }).catch(() => undefined);
    return run;
  }

  handle(msg: InboundMessage): Promise<void> {
    const key = this.key(msg.connectionId, msg.chatJid);
    const epoch = this.epochs.get(key) ?? 0;
    return this.enqueue(key, () => this.process(msg, epoch));
  }

  private available(msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">, epoch: number): boolean {
    return !msg.isGroup || (
      epoch === (this.epochs.get(this.key(msg.connectionId, msg.chatJid)) ?? 0) &&
      this.chatBots.membership(msg.connectionId, msg.chatJid)?.present !== 0
    );
  }

  /** Ownerless chats (unregistered DM sender, unqualified group) relay as the
   *  Client SA in the common room only when RELAY_UNREGISTERED_CHATS is on.
   *  Otherwise drop (audited) until an enabled registered shopper qualifies. */
  private unregisteredAllowed(connectionId: string, chatJid: string): boolean {
    if (this.deps.relayUnregisteredChats) return true;
    this.audit.record("inbound.rejected", {
      subjectType: "connection", subjectId: connectionId,
      detail: { chatJid: maskJid(chatJid), reason: "unregistered_chat_relay_disabled" },
    });
    this.log.info("unregistered chat dropped", { chatJid: maskJid(chatJid), reason: "unregistered_chat_relay_disabled" });
    return false;
  }

  private clientReady(connectionId: string, chatJid: string): boolean {
    if (this.deps.settings.getStatus().setupComplete) return true;
    this.audit.record("inbound.rejected", {
      subjectType: "connection", subjectId: connectionId,
      detail: { chatJid: maskJid(chatJid), reason: "gateway_setup_incomplete" },
    });
    this.log.info("client traffic dropped", { chatJid: maskJid(chatJid), reason: "gateway_setup_incomplete" });
    return false;
  }

  private async destination(msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup" | "senderPhoneE164" | "fromMe">): Promise<Destination | null> {
    const existing = this.chatBots.get(msg.connectionId, msg.chatJid);
    if (msg.isGroup) {
      if (this.chatBots.membership(msg.connectionId, msg.chatJid)?.present === 0) return null;
      const group = await this.deps.getGroup(msg.chatJid);
      if (!group?.linkedMember) return null;
      const membership = this.chatBots.membership(msg.connectionId, msg.chatJid);
      const author = membership?.added_by_jid;
      const authorPhone = author
        ? phoneE164FromJid(author) ?? group.participants.find((p) => p.jid === author)?.phone_e164 ?? null
        : null;
      const candidate = this.resolver.groupOwner(
        group.participants.flatMap((p) => p.phone_e164 ? [p.phone_e164] : []), authorPhone,
      );
      // Shopper-owned bots stay fixed. A common-room bot is replaced when
      // registration or membership makes this group qualify for a shopper.
      const fixed = existing?.shopperId ? existing : null;
      const ownerId = fixed?.shopperId ?? candidate?.id ?? null;
      const owner = fixed ? this.resolver.byId(ownerId) : candidate;
      const roomName = fixed?.roomName ?? owner?.roomName ?? existing?.roomName ?? this.deps.settings.getCommonRoomName();
      if (!roomName) { this.clientReady(msg.connectionId, msg.chatJid); return null; }
      if (ownerId === null && !this.unregisteredAllowed(msg.connectionId, msg.chatJid)) return null;
      return { owner, ownerId, roomName, qualified: Boolean(candidate) };
    }
    // fromMe is the linked phone, so use its peer to determine a fresh DM's owner.
    const peerPhone = msg.fromMe ? phoneE164FromJid(msg.chatJid) : msg.senderPhoneE164;
    const candidate = this.resolver.registered(peerPhone);
    const fixed = existing?.shopperId ? existing : null;
    const ownerId = fixed?.shopperId ?? candidate?.id ?? null;
    const owner = fixed ? this.resolver.byId(ownerId) : candidate;
    const roomName = fixed?.roomName ?? candidate?.roomName ?? existing?.roomName ?? this.deps.settings.getCommonRoomName();
    if (!roomName) { this.clientReady(msg.connectionId, msg.chatJid); return null; }
    if (ownerId === null && !this.unregisteredAllowed(msg.connectionId, msg.chatJid)) return null;
    return { owner, ownerId, roomName, qualified: false };
  }

  private identity(msg: InboundMessage, dest: Destination): PostingIdentity {
    if (msg.fromMe) {
      return dest.owner ? { role: "shopper", shopperId: dest.owner.id } : CLIENT;
    }
    if (msg.isGroup && !dest.qualified) return CLIENT;
    const shopper = this.resolver.registered(msg.senderPhoneE164);
    return shopper ? { role: "shopper", shopperId: shopper.id } : CLIENT;
  }

  private remember(msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">, dest: Destination, ask: AskResult): ChatBot {
    return this.chatBots.upsert({
      connectionId: msg.connectionId, chatJid: msg.chatJid,
      shopperId: dest.ownerId, threadId: ask.threadId, roomName: dest.roomName,
      relayPausedAt: msg.isGroup && this.chatBots.membership(msg.connectionId, msg.chatJid)?.present === 0 ? nowIso() : null,
    });
  }

  private async submit(
    msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">,
    dest: Destination, identity: PostingIdentity, query: string,
    agentResponse: "force_skip" | "force_respond", files: PromptQlFileInput[] = [],
    rememberFailure = true, messageId?: string,
  ): Promise<AskResult> {
    const existing = this.chatBots.get(msg.connectionId, msg.chatJid);
    // Never continue the common bot using a newly registered shopper's
    // destination. Keep the old mapping until MCP returns a new handle.
    const promoting = existing?.shopperId === null && dest.ownerId !== null;
    try {
      const ask = await this.adapter.ask(identity, {
        query, threadId: promoting ? null : existing?.threadId ?? null,
        roomName: !existing || promoting ? dest.roomName : null, agentResponse, files,
      });
      this.remember(msg, dest, ask);
      return ask;
    } catch (err) {
      if (err instanceof AskSubmissionError) {
        this.remember(msg, dest, err.ask);
        // Retain only the text, encrypted. Media bytes are never retained.
        // Recovery is a relay, not a second triggering attempt.
        if (rememberFailure) this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, { identity, query, messageId });
      }
      throw err;
    }
  }

  private async retryPending(msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">, dest: Destination): Promise<void> {
    const pending = this.chatBots.pendingPost(msg.connectionId, msg.chatJid);
    if (!pending) return;
    // Pending text belongs to the stored bot, not a newly eligible destination.
    // Finish recovery there before switching the chat to a shopper-owned bot.
    const existing = this.chatBots.get(msg.connectionId, msg.chatJid)!;
    const pendingDest = {
      ...dest, ownerId: existing.shopperId, owner: this.resolver.byId(existing.shopperId),
      roomName: existing.roomName ?? dest.roomName,
    };
    if (pending.identity.role === "client" && !this.clientReady(msg.connectionId, msg.chatJid)) throw new Error("Gateway setup incomplete");
    await this.submit(msg, pendingDest, pending.identity, pending.query, "force_skip", [], true, pending.messageId);
    if (pending.messageId) {
      this.deps.messages.markRelayed(msg.connectionId, msg.chatJid, pending.messageId);
      const claim = this.outboundLog.claim(msg.connectionId, pending.messageId);
      if (claim.status === "claimed") this.outboundLog.markRelayed(msg.connectionId, pending.messageId, claim.token, msg.chatJid);
    }
    this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, null);
  }

  /** Best-effort 👀 so users see the agent will respond. Never fails the flow. */
  private ackAgent(msg: InboundMessage): void {
    if (!this.deps.reactToMessage) return;
    void this.deps.reactToMessage(msg, AGENT_ACK_EMOJI).catch((err) =>
      this.log.warn("agent ack reaction failed", { corrId: msg.messageId, chatJid: maskJid(msg.chatJid), err }),
    );
  }

  private async process(msg: InboundMessage, epoch: number): Promise<void> {
    let claimToken: string | null = null;
    const log = this.log.child({ corrId: msg.messageId, chatJid: maskJid(msg.chatJid) });
    try {
      if (msg.fromMe && this.outboundLog.isGatewayMessage(msg.connectionId, msg.chatJid, msg.messageId)) return;
      if (!this.available(msg, epoch) || !promptQlQuery(msg)) return;
      const dest = await this.destination(msg);
      if (!dest || !this.available(msg, epoch)) return;
      const identity = this.identity(msg, dest);
      if (identity.role === "client" && !this.clientReady(msg.connectionId, msg.chatJid)) return;

      await this.retryPending(msg, dest);
      const claim = this.outboundLog.claim(msg.connectionId, msg.messageId);
      if (claim.status !== "claimed") return;
      claimToken = claim.token;
      if (!this.available(msg, epoch)) throw new Error("Group membership changed");

      const shopperTrigger = !msg.fromMe && identity.role === "shopper" && (!msg.isGroup || msg.mentionsSelf);
      const paTrigger = !msg.fromMe && msg.isGroup && dest.qualified && msg.mentionsSelf &&
        identity.role === "client" && dest.owner?.status === "enabled";
      const files = msg.mediaStatus === "ready" && msg.media
        ? [promptQlFileFromMedia(msg.media, mediaFileName(msg.messageId, msg.msgType, msg.media.mime ?? null))]
        : [];
      let ask: AskResult;
      try {
        ask = await this.submit(msg, dest, identity,
          identity.role === "client" ? clientQuery(msg) : promptQlQuery(msg)!,
          shopperTrigger ? "force_respond" : "force_skip", files, true, msg.messageId);
        this.deps.messages.markRelayed(msg.connectionId, msg.chatJid, msg.messageId);
      } finally {
        msg.media = null;
        files.length = 0;
      }

      let responseIdentity = identity;
      if (paTrigger && this.available(msg, epoch)) {
        responseIdentity = { role: "pa", shopperId: dest.owner!.id };
        ask = await this.submit(msg, dest, responseIdentity, paPrompt(dest.owner!.name), "force_respond");
      }
      if ((!shopperTrigger && !paTrigger) || !this.available(msg, epoch)) {
        this.outboundLog.markRelayed(msg.connectionId, msg.messageId, claim.token, msg.chatJid);
        return;
      }
      if (responseIdentity.role === "client") return;
      // Relayed to PromptQL with the agent on: acknowledge on the user's message
      // so they know a reply is coming, before the (possibly long) response wait.
      this.ackAgent(msg);
      const workflow = this.workflows.create({
        connectionId: msg.connectionId, chatJid: msg.chatJid,
        shopperId: responseIdentity.shopperId, inboundMessageId: msg.messageId, remoteRef: ask.threadId,
      });
      void this.dispatcher.dispatch({
        workflowId: workflow.id, connectionId: msg.connectionId, chatJid: msg.chatJid,
        shopperId: responseIdentity.shopperId, credentialRole: responseIdentity.role,
        idempotencyKey: msg.messageId, claimToken: claim.token,
        threadId: ask.threadId, threadEventId: ask.threadEventId,
        pacingProfile: responseIdentity.role === "pa" ? "pa_reply" : "default",
      }).catch((err) => log.error("outbound dispatch failed", { err }));
    } catch (err) {
      if (claimToken) this.outboundLog.markFailed(msg.connectionId, msg.messageId, claimToken);
      log.error("inbound error", { err });
    } finally {
      msg.media = null;
    }
  }

  onHistoryBatch(event: HistoryBatchEvent): Promise<void> {
    const parsed = MembershipSchema.extend({ count: z.number().int().nonnegative() }).parse(event);
    const key = this.key(parsed.connectionId, parsed.groupJid);
    const epoch = this.epochs.get(key) ?? 0;
    return this.enqueue(key, async () => {
      const msg = { connectionId: parsed.connectionId, chatJid: parsed.groupJid, isGroup: true, senderPhoneE164: null, fromMe: false };
      let rows = this.deps.messages.listUnrelayedHistory(msg.connectionId, msg.chatJid);
      if (!rows.length || !this.available(msg, epoch) || !this.clientReady(msg.connectionId, msg.chatJid)) return;
      const dest = await this.destination(msg);
      if (!dest || !this.available(msg, epoch)) return;
      try {
        // History can be the first traffic after registration too. Do not
        // carry the old common bot's live retry into the replacement bot.
        if (this.chatBots.get(msg.connectionId, msg.chatJid)?.shopperId === null && dest.ownerId !== null) {
          await this.retryPending(msg, dest);
          if (!this.available(msg, epoch)) return;
          // A recovered live message may also have arrived in this history batch.
          rows = this.deps.messages.listUnrelayedHistory(msg.connectionId, msg.chatJid);
          if (!rows.length) return;
        }
        await this.submit(msg, dest, CLIENT, `Replaying ${rows.length} messages from group history, oldest first`, "force_skip", [], false);
        for (const row of rows) {
          if (!this.available(msg, epoch)) return;
          let replay: InboundMessage | null = null;
          try {
            replay = await this.deps.prepareHistory(row);
            if (!replay || !this.available(msg, epoch)) continue;
            const identity = this.identity(replay, dest);
            const files = replay.mediaStatus === "ready" && replay.media
              ? [promptQlFileFromMedia(replay.media, mediaFileName(replay.messageId, replay.msgType, replay.media.mime ?? null))]
              : [];
            const query = identity.role === "client" ? clientQuery(replay) : promptQlQuery(replay);
            if (!query) continue;
            // Failed history stays in the history repository, not the live retry slot.
            await this.submit(msg, dest, identity, query, "force_skip", files, false);
            this.deps.messages.markRelayed(row.connectionId, row.chatJid, row.messageId);
          } catch {
            this.log.warn("history row relay failed", { corrId: row.messageId, chatJid: maskJid(row.chatJid) });
          } finally {
            if (replay) replay.media = null;
          }
        }
        if (this.available(msg, epoch)) await this.submit(msg, dest, CLIENT, "End of history", "force_skip", [], false);
      } catch {
        this.log.warn("history bracket relay failed", { chatJid: maskJid(msg.chatJid) });
      }
    });
  }
}

/** Shopper text is unchanged. Media without a caption gets only its kind. */
export function promptQlQuery(msg: InboundMessage, _attached = false): string | null {
  if (msg.text.trim()) return msg.text;
  const media = mediaLabel(msg);
  if (!media) return null;
  return media.kind === "document" && media.fileName ? `(document: ${media.fileName})` : `(${media.kind})`;
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
