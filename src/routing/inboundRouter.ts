import { z } from "zod";
import type { InboundMessage, HistoryBatchEvent, RoutingGroup } from "../whatsapp/socket.ts";
import type { SelfMembershipEvent } from "../whatsapp/groupEvents.ts";
import type { ShopperResolver } from "./resolver.ts";
import {
  AskSubmissionError, promptQlFileFromMedia, promptQlUploadRawBytes,
  type PromptQlAdapter, type PromptQlFileInput, type PostingIdentity, type AskResult,
} from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { ChatBotRepo, ChatBot } from "../storage/chatBotRepo.ts";
import type { MessageStore, StoredHistoryMessage } from "../storage/messageStore.ts";
import type { GatewaySettingsRepo } from "../storage/gatewaySettingsRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { WelcomeLogRepo } from "../storage/welcomeLog.ts";
import type { AuditLog } from "../storage/auditLog.ts";
import type { OutboundDispatcher } from "./outboundDispatcher.ts";
import type { Logger } from "../logger.ts";
import type { Shopper } from "../domain/types.ts";
import { clientQuery, mediaLabel, paPrompt } from "./groupRelay.ts";
import { formatClientEnvelope } from "../promptql/clientEnvelope.ts";
import { phoneE164FromJid, maskJid, nowIso } from "../util.ts";
import { isPureGreeting, OPERATOR_WELCOME_PROMPT } from "../domain/welcomeMessage.ts";

export interface RoutingDeps {
  settings: GatewaySettingsRepo;
  messages: MessageStore;
  welcomeLog?: WelcomeLogRepo;
  getGroup: (groupJid: string) => Promise<RoutingGroup | null>;
  prepareHistory: (row: StoredHistoryMessage) => Promise<InboundMessage | null>;
  /** Add a WhatsApp reaction to an inbound message. Best-effort; optional so
   *  tests and non-reacting wirings can omit it. */
  reactToMessage?: (msg: InboundMessage, emoji: string) => Promise<void>;
  /** Relay ownerless (unregistered DM / unqualified group) chats to the common
   *  room. Off by default: such chats are dropped (audited), never relayed,
   *  until an enabled registered shopper qualifies them. */
  relayUnregisteredChats?: boolean;
  /** Inbound debouncing window in milliseconds (0 = disabled). */
  inboundDebounceMs?: number;
  /** Issue #25: preformatted shared-craft system_instruction (craft-only, no PII). */
  orgCraftSystemInstruction?: string;
}

/** Shown on a relayed message once the agent is asked to respond (force_respond),
 *  so users know a reply is coming. */
const AGENT_ACK_EMOJI = "👀";
/**
 * Two or more photos in one ask_promptql body are what live traffic rejects
 * with `upload_failed` (Chanel bag + invoice, 2026-09-29). Above this decoded
 * size, send the files as separate posts instead of building that body.
 */
const MULTI_FILE_UPLOAD_BUDGET_BYTES = 5 * 1024 * 1024;
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

interface InboundBufferEntry {
  msg: InboundMessage;
  epoch: number;
}

interface InboundBuffer {
  items: InboundBufferEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves when this buffer has been processed/flushed. */
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class InboundRouter {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private readonly clientBuffers = new Map<string, InboundBuffer>();

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

  private bufferKey(connectionId: string, chatJid: string, senderKey: string): string {
    return JSON.stringify([connectionId, chatJid, senderKey]);
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
    const chatKey = this.key(msg.connectionId, msg.chatJid);
    const epoch = this.epochs.get(chatKey) ?? 0;
    const debounceMs = this.deps.inboundDebounceMs ?? 0;

    // Direct bypass if debouncing is disabled (0ms) or message is from gateway itself
    if (debounceMs <= 0 || (msg.fromMe && this.outboundLog.isGatewayMessage(msg.connectionId, msg.chatJid, msg.messageId))) {
      return this.enqueue(chatKey, () => this.processBatch([msg], epoch));
    }

    const senderKey = msg.senderPhoneE164 ?? msg.senderJid;
    const bufKey = this.bufferKey(msg.connectionId, msg.chatJid, senderKey);

    let buf = this.clientBuffers.get(bufKey);
    if (!buf) {
      let resolvePromise!: () => void;
      let rejectPromise!: (err: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      buf = {
        items: [{ msg, epoch }],
        timer: null,
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
      };

      buf.timer = setTimeout(() => {
        this.flushBuffer(bufKey);
      }, debounceMs);

      this.clientBuffers.set(bufKey, buf);
      return buf.promise;
    }

    // Append to existing buffer and reset debounce timer
    buf.items.push({ msg, epoch });
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      this.flushBuffer(bufKey);
    }, debounceMs);

    return buf.promise;
  }

  private flushBuffer(bufKey: string): void {
    const buf = this.clientBuffers.get(bufKey);
    if (!buf) return;
    this.clientBuffers.delete(bufKey);
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }

    const messages = buf.items.map((i) => i.msg);
    const lastEpoch = buf.items[buf.items.length - 1].epoch;
    const firstMsg = messages[0];
    const chatKey = this.key(firstMsg.connectionId, firstMsg.chatJid);

    void this.enqueue(chatKey, () => this.processBatch(messages, lastEpoch))
      .then(() => buf.resolve())
      .catch((err) => {
        buf.reject(err);
      });
  }

  private available(msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">, epoch: number): boolean {
    return !msg.isGroup || (
      epoch === (this.epochs.get(this.key(msg.connectionId, msg.chatJid)) ?? 0) &&
      this.chatBots.membership(msg.connectionId, msg.chatJid)?.present !== 0
    );
  }

  /** Ownerless chats (unregistered DM sender, unqualified group) relay as the
   *  Client SA in the common room only when RELAY_UNREGISTERED_CHATS is on.
   *  Otherwise drop (audited) until an enabled registered shopper qualifies them. */
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
    const roomName = fixed?.roomName ?? owner?.roomName ?? existing?.roomName ?? this.deps.settings.getCommonRoomName();
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

  /**
   * One PromptQL post, or several when a multi-file upload is the thing
   * PromptQL rejects. A same-body retry does not change `upload_failed`.
   * Files after the first are context (`force_skip`); the last post keeps
   * the turn's response mode so the agent still answers once.
   */
  private async submitTurn(
    msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">,
    dest: Destination, identity: PostingIdentity, query: string,
    agentResponse: "force_skip" | "force_respond", files: PromptQlFileInput[],
    rememberFailure: boolean, messageId: string | undefined, log: Logger,
  ): Promise<AskResult> {
    const oversized = files.length > 1 && promptQlUploadRawBytes(files) > MULTI_FILE_UPLOAD_BUDGET_BYTES;
    if (oversized) {
      log.warn("splitting media upload to stay within PromptQL request budget", {
        fileCount: files.length, totalBytes: promptQlUploadRawBytes(files),
      });
      return this.submitFilesOneByOne(msg, dest, identity, query, agentResponse, files, rememberFailure, messageId);
    }
    try {
      return await this.submit(msg, dest, identity, query, agentResponse, files, rememberFailure, messageId);
    } catch (err) {
      if (!(err instanceof AskSubmissionError) || err.status !== "upload_failed" || files.length === 0) {
        throw err;
      }
      if (files.length > 1) {
        // Live 2026-09-29: bag + invoice photo failed twice as one files[]
        // payload, then the operator only got a resend notice.
        log.warn("ask upload_failed; uploading each file on its own", { fileCount: files.length });
        const ask = await this.submitFilesOneByOne(
          msg, dest, identity, query, agentResponse, files, rememberFailure, messageId,
        );
        this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, null);
        return ask;
      }
      log.warn("ask upload_failed; retrying once", { status: err.status, fileCount: files.length });
      const ask = await this.submit(msg, dest, identity, query, agentResponse, files, rememberFailure, messageId);
      this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, null);
      return ask;
    }
  }

  private async submitFilesOneByOne(
    msg: Pick<InboundMessage, "connectionId" | "chatJid" | "isGroup">,
    dest: Destination, identity: PostingIdentity, query: string,
    agentResponse: "force_skip" | "force_respond", files: PromptQlFileInput[],
    rememberFailure: boolean, messageId: string | undefined,
  ): Promise<AskResult> {
    let ask!: AskResult;
    for (let i = 0; i < files.length; i++) {
      const last = i === files.length - 1;
      const file = files[i]!;
      try {
        ask = await this.submit(
          msg, dest, identity,
          last ? query : uploadRelayQuery(file),
          last ? agentResponse : "force_skip",
          [file],
          last && rememberFailure,
          messageId,
        );
      } catch (err) {
        if (!last && rememberFailure) {
          this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, { identity, query, messageId });
        }
        throw err;
      }
      if (!last) this.chatBots.setPendingPost(msg.connectionId, msg.chatJid, null);
    }
    return ask;
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
      const systemInstruction = this.deps.orgCraftSystemInstruction || undefined;
      const ask = await this.adapter.ask(identity, {
        query, threadId: promoting ? null : existing?.threadId ?? null,
        roomName: !existing || promoting ? dest.roomName : null, agentResponse, files,
        ...(systemInstruction ? { systemInstruction } : {}),
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

  private formatBatchClientEnvelope(messages: InboundMessage[]): string {
    const first = messages[0];
    const textParts: string[] = [];
    const hasText = messages.some((m) => m.text.trim().length > 0);

    for (const m of messages) {
      if (m.text.trim()) {
        textParts.push(m.text.trim());
      } else {
        const media = mediaLabel(m);
        if (media) {
          const fileName = media.fileName?.replace(/[\r\n\u2028\u2029]/g, " ").trim();
          if (media.kind === "document" && fileName) {
            textParts.push(`(document: ${fileName})`);
          } else if (!hasText && media.kind !== "image") {
            textParts.push(`(${media.kind})`);
          } else if (!hasText && media.kind === "image" && textParts.length === 0) {
            textParts.push(`(${media.kind})`);
          }
        }
      }
    }

    const mergedText = textParts.join("\n");
    return formatClientEnvelope({
      displayName: first.pushName,
      phoneE164: first.senderPhoneE164,
      lid: first.senderJid.endsWith("@lid") ? first.senderJid : null,
      text: mergedText,
      media: null,
    });
  }

  private async processBatch(messages: InboundMessage[], epoch: number): Promise<void> {
    if (!messages.length) return;
    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    const log = this.log.child({ corrId: firstMsg.messageId, chatJid: maskJid(firstMsg.chatJid), batchSize: messages.length });

    const claimedTokens: { msg: InboundMessage; token: string }[] = [];
    let shopperMediaAsk = false;
    try {
      if (firstMsg.fromMe && this.outboundLog.isGatewayMessage(firstMsg.connectionId, firstMsg.chatJid, firstMsg.messageId)) return;
      if (!this.available(firstMsg, epoch)) return;

      const validMessages = messages.filter((m) => Boolean(promptQlQuery(m)));
      if (!validMessages.length) return;

      const dest = await this.destination(firstMsg);
      if (!dest || !this.available(firstMsg, epoch)) return;
      const identity = this.identity(firstMsg, dest);
      if (identity.role === "client" && !this.clientReady(firstMsg.connectionId, firstMsg.chatJid)) return;

      await this.retryPending(firstMsg, dest);

      for (const m of validMessages) {
        const claim = this.outboundLog.claim(m.connectionId, m.messageId);
        if (claim.status === "claimed") {
          claimedTokens.push({ msg: m, token: claim.token });
        }
      }
      if (!claimedTokens.length) return;
      if (!this.available(firstMsg, epoch)) throw new Error("Group membership changed");

      // Check triggers across all messages in the batch
      const shopperTrigger = validMessages.some((m) =>
        !m.fromMe && identity.role === "shopper" && (!m.isGroup || m.mentionsSelf)
      );
      const paTrigger = validMessages.some((m) =>
        !m.fromMe && m.isGroup && dest.qualified && m.mentionsSelf &&
        identity.role === "client" && dest.owner?.status === "enabled"
      );

      // Welcome message evaluation (Room 13):
      // Trigger: Registered operator's first inbound 1:1 direct message (never in groups).
      const isOperatorDM = !firstMsg.fromMe && !firstMsg.isGroup && identity.role === "shopper";
      const isFirstOperatorDM = isOperatorDM &&
        Boolean(this.deps.welcomeLog && !this.deps.welcomeLog.isWelcomeSent(identity.shopperId, firstMsg.connectionId));

      let rawQuery: string;
      if (identity.role === "client") {
        rawQuery = this.formatBatchClientEnvelope(validMessages);
      } else {
        rawQuery = validMessages.map((m) => promptQlQuery(m)!).join("\n");
      }

      const isGreetingFirstDM = isFirstOperatorDM && isPureGreeting(rawQuery);
      const isRequestFirstDM = isFirstOperatorDM && !isGreetingFirstDM;

      // Collect all ready media files across all messages in the batch into files array
      const files: PromptQlFileInput[] = [];
      for (const m of validMessages) {
        if (m.mediaStatus === "ready" && m.media) {
          files.push(promptQlFileFromMedia(m.media, mediaFileName(m.messageId, m.msgType, m.media.mime ?? null)));
        }
      }
      const hadReadyMedia = files.length > 0;
      shopperMediaAsk = identity.role === "shopper" && hadReadyMedia && !firstMsg.fromMe;
      const agentResponse = (shopperTrigger && !isGreetingFirstDM) ? "force_respond" as const : "force_skip" as const;

      let ask: AskResult;
      try {
        ask = await this.submitTurn(
          firstMsg, dest, identity, rawQuery, agentResponse, files, true, firstMsg.messageId, log,
        );
        for (const m of validMessages) {
          this.deps.messages.markRelayed(m.connectionId, m.chatJid, m.messageId);
        }
      } finally {
        for (const m of validMessages) {
          m.media = null;
        }
        files.length = 0;
      }

      let responseIdentity = identity;
      if (paTrigger && this.available(firstMsg, epoch)) {
        responseIdentity = { role: "pa", shopperId: dest.owner!.id };
        ask = await this.submit(firstMsg, dest, responseIdentity, paPrompt(dest.owner!.name), "force_respond");
      }

      if ((!shopperTrigger && !paTrigger && !isGreetingFirstDM) || !this.available(firstMsg, epoch)) {
        for (const { msg, token } of claimedTokens) {
          this.outboundLog.markRelayed(msg.connectionId, msg.messageId, token, msg.chatJid);
        }
        return;
      }

      if (responseIdentity.role === "client") return;

      // Relayed to PromptQL with the agent on: acknowledge on the triggering message(s)
      const triggeringMsg = validMessages.slice().reverse().find((m) => m.mentionsSelf) ?? lastMsg;
      this.ackAgent(triggeringMsg);

      const workflow = this.workflows.create({
        connectionId: firstMsg.connectionId,
        chatJid: firstMsg.chatJid,
        shopperId: responseIdentity.shopperId,
        inboundMessageId: triggeringMsg.messageId,
        remoteRef: ask.threadId,
      });

      const primaryClaim = claimedTokens.find((c) => c.msg.messageId === triggeringMsg.messageId) ?? claimedTokens[claimedTokens.length - 1];

      // Mark other messages in batch as relayed in outboundLog
      for (const { msg, token } of claimedTokens) {
        if (msg.messageId !== primaryClaim.msg.messageId) {
          this.outboundLog.markRelayed(msg.connectionId, msg.messageId, token, msg.chatJid);
        }
      }

      if (isGreetingFirstDM) {
        // Deterministic welcome reply for pure greeting first DM: bypass LLM waiting and send approved template directly
        void this.dispatcher.dispatchDirectText({
          workflowId: workflow.id,
          connectionId: firstMsg.connectionId,
          chatJid: firstMsg.chatJid,
          shopperId: responseIdentity.shopperId,
          idempotencyKey: primaryClaim.msg.messageId,
          claimToken: primaryClaim.token,
          text: OPERATOR_WELCOME_PROMPT,
          isWelcomeDispatch: true,
        }).catch((err) => log.error("direct welcome dispatch failed", { err }));
      } else {
        void this.dispatcher.dispatch({
          workflowId: workflow.id,
          connectionId: firstMsg.connectionId,
          chatJid: firstMsg.chatJid,
          shopperId: responseIdentity.shopperId,
          credentialRole: responseIdentity.role,
          idempotencyKey: primaryClaim.msg.messageId,
          claimToken: primaryClaim.token,
          threadId: ask.threadId,
          threadEventId: ask.threadEventId,
          pacingProfile: responseIdentity.role === "pa" ? "pa_reply" : "default",
          isWelcomeDispatch: isRequestFirstDM,
          welcomePrefix: isRequestFirstDM,
        }).catch((err) => log.error("outbound dispatch failed", { err }));
      }
    } catch (err) {
      for (const { msg, token } of claimedTokens) {
        this.outboundLog.markFailed(msg.connectionId, msg.messageId, token);
      }
      log.error("inbound batch error", { err });
      // Do not leave operators in total silence when PromptQL rejects media upload.
      if (
        shopperMediaAsk &&
        err instanceof AskSubmissionError &&
        (err.status === "upload_failed" || err.status === "sent_message_failed")
      ) {
        const notice = err.status === "upload_failed"
          ? "Got your photo, but I couldn't upload it just now. Please resend it once and I'll pick it up."
          : "I hit a snag sending that to my workspace. Please resend and I'll try again.";
        // Best-effort. A missing or throwing notifier must not reject the batch.
        void Promise.resolve()
          .then(() => this.dispatcher.notifyChat({
            connectionId: firstMsg.connectionId,
            chatJid: firstMsg.chatJid,
            text: notice,
          }))
          .catch((notifyErr) => log.warn("upload-failure notice failed", { err: notifyErr }));
      }
    } finally {
      for (const m of messages) {
        m.media = null;
      }
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
            await this.submitTurn(msg, dest, identity, query, "force_skip", files, false, replay.messageId, this.log);
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

/** Context-only label for a file that is not the last post of a split upload.
 * No caption and no sender text — those stay on the responding post. */
function uploadRelayQuery(file: PromptQlFileInput): string {
  if (file.mime_type.startsWith("image/")) return "(image)";
  if (file.mime_type.startsWith("audio/")) return "(audio)";
  if (file.mime_type.startsWith("video/")) return "(video)";
  return "(file)";
}

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