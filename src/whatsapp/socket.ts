/**
 * Single-connection Baileys lifecycle. One process, one number (the schema is
 * connection_id-keyed, so hosting several numbers is an additive change later).
 *
 * Ban-risk contract honored here:
 *   - Pairing-code ONLY (no QR surfaced); browser tuple is a stock Browsers.*
 *     preset (WhatsApp rejects the pairing code otherwise).
 *   - Always fetchLatestWaWebVersion() — never the bundled Baileys default,
 *     which goes stale and makes linking loop on 401/428.
 *   - creds.update persisted immediately.
 *   - loggedOut (401) on an already-linked connection => STOP, never auto-relink.
 *     Transient closes use capped exponential backoff.
 *   - Graceful shutdown uses ws.close(), never logout() (which unlinks the device).
 *
 * Inbound messages are captured (for loop-prevention + debugging) and handed to
 * the `onInbound` hook. This layer stays PromptQL-agnostic.
 */

import makeWASocket, {
  Browsers,
  BufferJSON,
  generateMessageIDV2,
  normalizeMessageContent,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WAMessage,
  type WASocket,
} from "baileys";
import { z } from "zod";
import { ownJids, mentionsSelf, selfParticipantUpdate, selfGroupUpserts, parseHistoryBatch, parseHistoryMessage, type SelfMembershipEvent } from "./groupEvents.ts";
import { OutboundLog } from "../storage/outboundLog.ts";
import { Boom } from "@hapi/boom";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { useSqliteAuthState, type AuthStateHandle } from "./authState.ts";
import { AntiBanQueue, PacingProfileSchema, type PacingProfile, type SendContext } from "./antiBan.ts";
import { GroupMetaStore } from "./groupMeta.ts";
import { rootLogger, type Logger } from "../logger.ts";
import { encrypt, decryptToString } from "../crypto.ts";
import type { StoredHistoryMessage, MessageStore } from "../storage/messageStore.ts";
import {
  classifyMessage,
  hasMedia,
  TransientMediaDownloader,
  type DownloadedMedia,
  type MediaStatus,
} from "./media.ts";
import {
  e164ToPairingNumber,
  isGroupJid,
  isLidJid,
  jidUser,
  maskJid,
  maskNumber,
  nowIso,
  phoneE164FromJid,
} from "../util.ts";

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 2_000;
const MAX_LINK_ATTEMPTS = 20;
const MAX_LOGGEDOUT_RETRIES = 4;

export interface InboundMessage {
  connectionId: string;
  chatJid: string;
  senderJid: string;
  senderPhoneE164: string | null;
  messageId: string;
  ts: number;
  text: string;
  msgType: string;
  mediaStatus: MediaStatus;
  media: DownloadedMedia | null;
  isGroup: boolean;
  fromMe: boolean;
  mentionsSelf: boolean;
}

export interface HistoryBatchEvent extends SelfMembershipEvent {
  /** Newly captured rows only, excluding any message already stored live/history. */
  count: number;
}

export interface SocketHooks {
  /** One notification per group in a history batch, after persistence. No live hook.
   * Awaited before the next queued input so replay can finish before later live work. */
  onHistoryBatch?: (event: HistoryBatchEvent) => void | Promise<void>;
  onSelfRemoved?: (event: SelfMembershipEvent) => void;
  onSelfAdded?: (event: SelfMembershipEvent) => void;
  /** Called for each captured inbound message (already persisted). */
  onInbound?: (msg: InboundMessage) => void | Promise<void>;
  /** Called when the connection transitions to logged_out (human must re-link). */
  onLoggedOut?: (connectionId: string) => void;
  /** Called with a fresh pairing code to show the operator. */
  onPairingCode?: (connectionId: string, code: string) => void;
  /** Called when the connection opens linked. */
  onLinked?: (connectionId: string, linkedAtMs: number) => void;
}

export type LinkStatus = "pending" | "linked" | "logged_out";

interface LiveState {
  sock: WASocket | null;
  auth: AuthStateHandle;
  status: LinkStatus;
  linkedAtMs: number | null;
  linkAttempts: number;
  loggedOutRetries: number;
  pairingRequested: boolean;
  stopped: boolean;
  pairingCode: string | undefined;
  /** The number this connection is (re)linking. Settable via link(); persisted
   *  in whatsapp_connection so a restart resumes the same number without env. */
  number: string;
  deviceLabel: string | undefined;
}

export class WhatsAppConnection {
  private live: LiveState;
  private readonly groups: GroupMetaStore;
  private readonly media: TransientMediaDownloader;
  private readonly log: Logger;
  private readonly outboundLog: OutboundLog;
  private readonly groupEpochs = new Map<string, number>();
  private readonly pendingHistoryGroups = new Set<string>();
  private inboundQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly antiBan: AntiBanQueue,
    private readonly messages: MessageStore,
    private readonly hooks: SocketHooks = {},
    log?: Logger,
  ) {
    this.log = (log ?? rootLogger).child({
      component: "whatsapp",
      connectionId: config.connectionId,
    });
    this.outboundLog = new OutboundLog(db);
    this.groups = new GroupMetaStore(db, config.groupMetaTtlMs, this.log);
    this.media = new TransientMediaDownloader(
      config.maxMediaBytes,
      this.log.child({ component: "media" }),
    );
    const auth = useSqliteAuthState(db, config.connectionId, config.dataEncryptionKey);
    const linkedAtMs = this.readLinkedAt();
    const persisted = this.readConnectionRow();
    this.live = {
      sock: null,
      auth,
      status: linkedAtMs ? "linked" : "pending",
      linkedAtMs,
      linkAttempts: 0,
      loggedOutRetries: 0,
      pairingRequested: false,
      stopped: false,
      pairingCode: undefined,
      // The number comes only from persisted state (set via the link API);
      // empty until the first link. Device label falls back to the env default.
      number: persisted?.number_e164 ?? "",
      deviceLabel: persisted?.device_label ?? config.deviceLabel,
    };
  }

  get number(): string {
    return this.live.number;
  }

  get status(): LinkStatus {
    return this.live.status;
  }
  get pairingCode(): string | undefined {
    return this.live.pairingCode;
  }
  get linkedAtMs(): number | null {
    return this.live.linkedAtMs;
  }

  private readLinkedAt(): number | null {
    const row = this.readConnectionRow();
    if (!row || row.link_status !== "linked" || !row.linked_at) return null;
    return new Date(row.linked_at).getTime();
  }

  private readConnectionRow(): {
    number_e164: string;
    link_status: string;
    linked_at: string | null;
    device_label: string | null;
  } | null {
    return (
      this.db
        .query<
          {
            number_e164: string;
            link_status: string;
            linked_at: string | null;
            device_label: string | null;
          },
          [string]
        >(
          "SELECT number_e164, link_status, linked_at, device_label FROM whatsapp_connection WHERE connection_id = ?",
        )
        .get(this.config.connectionId) ?? null
    );
  }

  private upsertConnectionRow(status: LinkStatus, linkedAtMs?: number | null): void {
    const ts = nowIso();
    const linkedAtIso =
      linkedAtMs != null ? new Date(linkedAtMs).toISOString() : null;
    this.db.run(
      `INSERT INTO whatsapp_connection
         (connection_id, number_e164, link_status, link_method, device_label, linked_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pairing', ?, ?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         link_status = excluded.link_status,
         linked_at = COALESCE(excluded.linked_at, whatsapp_connection.linked_at),
         updated_at = excluded.updated_at`,
      [
        this.config.connectionId,
        this.live.number,
        status,
        this.live.deviceLabel ?? null,
        linkedAtIso,
        ts,
        ts,
      ],
    );
  }

  /** Start (or restart) the socket. Idempotent while running. */
  async start(): Promise<void> {
    this.live.stopped = false;
    await this.openSocket();
  }

  /** Graceful stop: close the websocket WITHOUT logging out (session preserved). */
  stop(): void {
    this.live.stopped = true;
    try {
      this.live.sock?.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Start (or restart) pairing for a number, via the management API. Wipes any
   * existing session so a fresh pairing code is issued — required because a
   * half-finished or old session makes WhatsApp reject the pairing code. Returns
   * once pairing has been kicked off; poll `status`/`pairingCode` for the code.
   *
   * `numberE164` MUST already be canonical (the API canonicalizes).
   */
  async link(numberE164: string, deviceLabel?: string): Promise<void> {
    // Tear down any live socket first.
    this.stop();
    // Wipe persisted session so pairing starts clean (never carry stale creds).
    this.live.auth.clear();
    this.pendingHistoryGroups.clear();
    this.live.auth = useSqliteAuthState(
      this.db,
      this.config.connectionId,
      this.config.dataEncryptionKey,
    );
    this.live.number = numberE164;
    if (deviceLabel !== undefined) this.live.deviceLabel = deviceLabel;
    this.live.status = "pending";
    this.live.linkedAtMs = null;
    this.live.linkAttempts = 0;
    this.live.loggedOutRetries = 0;
    this.live.pairingRequested = false;
    this.live.pairingCode = undefined;
    this.upsertConnectionRow("pending", null);
    await this.start();
  }

  /**
   * Unlink: stop the socket and wipe the persisted session so a new number can
   * be linked. Does NOT call Baileys logout() (which would require the device to
   * still be reachable); wiping local creds is enough to force a fresh pairing.
   */
  unlink(): void {
    this.stop();
    this.live.auth.clear();
    this.pendingHistoryGroups.clear();
    this.live.status = "logged_out";
    this.live.linkedAtMs = null;
    this.live.pairingCode = undefined;
    this.upsertConnectionRow("logged_out", null);
  }

  private async openSocket(): Promise<void> {
    if (this.live.stopped) return;

    let version: [number, number, number] | undefined;
    try {
      const v = await fetchLatestWaWebVersion({});
      version = v.version;
    } catch (err) {
      this.log.warn("fetchLatestWaWebVersion failed, using library default (may be stale)", { err });
    }

    const sock = makeWASocket({
      version,
      auth: this.live.auth.state,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Anti-ban: serve group metadata from our SQLite cache so a group send
      // doesn't refetch + re-encrypt per participant on every message.
      cachedGroupMetadata: this.groups.cachedGroupMetadataProvider(
        this.config.connectionId,
      ),
    });
    this.live.sock = sock;

    sock.ev.on("creds.update", () => this.live.auth.saveCreds());

    // Request a pairing code only while the connection has NEVER linked and we
    // have not already requested one this socket. Never surface QR.
    if (
      this.live.linkedAtMs == null &&
      !this.live.pairingRequested &&
      !sock.authState.creds.registered
    ) {
      this.live.pairingRequested = true;
      const number = e164ToPairingNumber(this.live.number);
      // Give the socket a tick to open before requesting.
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          this.live.pairingCode = code;
          // The pairing code is a short-lived linking secret, not persistent PII;
          // it is surfaced to the operator via the hook / stdout, not the log.
          this.log.info("pairing code issued", { number: this.live.number });
          this.hooks.onPairingCode?.(this.config.connectionId, code);
        } catch (err) {
          this.log.error("requestPairingCode failed", { err });
        }
      }, 3_000);
    }

    sock.ev.on("connection.update", (u) => this.onConnectionUpdate(u));
    sock.ev.on("messages.upsert", (up) => {
      // Queue the whole download → PromptQL handoff. This bounds transient
      // attachment memory even when Baileys emits several upsert events.
      const epochs = new Map(this.groupEpochs);
      this.inboundQueue = this.inboundQueue
        .then(() => this.onMessagesUpsert(up, sock, epochs))
        .catch((err) => {
          this.log.error("inbound batch handling failed", { err });
        });
    });

    sock.ev.on("messaging-history.set", (history) => this.queueHistoryBatch(history, sock));

    // groups.update / group-participants.update → keep the group-metadata cache
    // fresh so cachedGroupMetadata stays warm (anti-ban).
    sock.ev.on("groups.update", async (updates) => {
      for (const u of updates) {
        if (!u.id) continue;
        if (u.subject !== undefined) {
          this.groups.applyPartialUpdate(this.config.connectionId, u.id, {
            subject: u.subject,
          });
        }
        await this.groups
          .readOrFetch(this.config.connectionId, u.id, sock)
          .catch(() => undefined);
      }
    });

    sock.ev.on("group-participants.update", (update) => this.onParticipantUpdate(update, sock));
    sock.ev.on("groups.upsert", (updates) => this.onGroupUpserts(updates, sock));
  }

  private onParticipantUpdate(update: unknown, sock: WASocket): void {
    try {
      const event = selfParticipantUpdate(update, sock.user);
      if (event) this.onSelfMembership(event.groupJid, event.action);
      // Do not re-fetch metadata after removal: the account cannot read it.
      if (event?.action === "remove") return;
      const { id } = z.object({ id: z.string().min(1) }).parse(update);
      void this.groups.readOrFetch(this.config.connectionId, id, sock)
        .catch(() => undefined);
    } catch {
      this.log.warn("invalid group participant event");
    }
  }

  private onGroupUpserts(updates: unknown, sock: WASocket): void {
    try {
      for (const groupJid of selfGroupUpserts(updates, sock.user)) {
        this.onSelfMembership(groupJid, "add");
      }
    } catch {
      this.log.warn("invalid group upsert event");
    }
  }

  private onSelfMembership(groupJid: string, action: "add" | "remove"): void {
    this.groupEpochs.set(groupJid, (this.groupEpochs.get(groupJid) ?? 0) + 1);
    const event = { connectionId: this.config.connectionId, groupJid };
    if (action === "remove") {
      this.pendingHistoryGroups.delete(groupJid);
      this.groups.remove(event.connectionId, groupJid);
      this.hooks.onSelfRemoved?.(event);
    } else {
      if (this.config.captureGroupHistory) this.pendingHistoryGroups.add(groupJid);
      this.groups.allowFetch(event.connectionId, groupJid);
      this.hooks.onSelfAdded?.(event);
    }
  }

  private queueHistoryBatch(payload: unknown, sock: WASocket): void {
    if (!this.config.captureGroupHistory) return;
    const epochs = new Map(this.groupEpochs);
    this.inboundQueue = this.inboundQueue
      .then(() => this.onHistoryBatch(payload, sock, epochs))
      .catch((err) => this.log.error("history batch handling failed", { err }));
  }

  private async onHistoryBatch(
    payload: unknown,
    sock: WASocket,
    epochs = new Map(this.groupEpochs),
  ): Promise<void> {
    if (!this.config.captureGroupHistory) return;
    let batch;
    try {
      batch = parseHistoryBatch(payload);
    } catch {
      this.log.warn("invalid history batch");
      return;
    }
    const grouped = new Map<string, WAMessage[]>();
    for (const value of batch.messages) {
      const message = parseHistoryMessage(value);
      if (!message) {
        // Do not log validation input: it contains message bodies and media keys.
        this.log.debug("history entry skipped: invalid or not a group message");
        continue;
      }
      const groupJid = message.key.remoteJid!;
      if (!this.pendingHistoryGroups.has(groupJid)) continue;
      if ((epochs.get(groupJid) ?? 0) !== (this.groupEpochs.get(groupJid) ?? 0)) continue;
      const messages = grouped.get(groupJid) ?? [];
      messages.push(message);
      grouped.set(groupJid, messages);
    }

    for (const [groupJid, messages] of grouped) {
      // A previous group's async replay may have overlapped a removal/re-add.
      if (!this.pendingHistoryGroups.has(groupJid) ||
        (epochs.get(groupJid) ?? 0) !== (this.groupEpochs.get(groupJid) ?? 0)) continue;
      // rc14 flattens newest-first conversation.messages and drops msgOrderId.
      // Stable sort keeps WhatsApp's order for equal-second timestamps after
      // reversing the source order; rowid retains that tie order on replay.
      messages.reverse().sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
      let count = 0;
      for (const message of messages) {
        const parsed = this.parseMessage(message, sock.user);
        if (!parsed) continue;
        parsed.ts = Number(message.messageTimestamp) * 1000;
        const normalized = { ...message, message: normalizeMessageContent(message.message) };
        parsed.msgType = classifyMessage(normalized);
        const envelope = encrypt(JSON.stringify({ ...message, messageTimestamp: Number(message.messageTimestamp) }, BufferJSON.replacer), this.config.dataEncryptionKey);
        if (!this.messages.captureHistory(parsed, envelope, hasMedia(normalized) ? "pending" : "none")) continue;
        count += 1;
        // Gateway replies already exist in the bot. Retain them for capture-all
        // bookkeeping but never return them as unrelayed history.
        if (parsed.fromMe && this.outboundLog.isGatewayMessage(parsed.connectionId, groupJid, parsed.messageId)) {
          this.messages.markRelayed(parsed.connectionId, groupJid, parsed.messageId);
        }
      }
      // No media allocation during capture. Replay downloads each retained
      // reference on demand through prepareHistoryMessage(), then releases it.
      // isLatest marks a first sync, so only progress=100 (or an unchunked event)
      // closes this join's capture window.
      if (batch.progress === 100 || (batch.progress == null && batch.chunkOrder == null)) {
        this.pendingHistoryGroups.delete(groupJid);
      }
      try {
        await this.hooks.onHistoryBatch?.({ connectionId: this.config.connectionId, groupJid, count });
      } catch {
        // Rows stay unrelayed and queryable even if the replay consumer fails.
        this.log.error("history batch callback failed", { groupJid: maskJid(groupJid) });
      }
    }
  }

  /** Replay helper: decode retained metadata and download media transiently.
   * This never posts or triggers anything. The caller must release media after
   * its single-message relay and markRelayed only after acceptance. */
  async prepareHistoryMessage(row: StoredHistoryMessage): Promise<InboundMessage | null> {
    z.object({
      connectionId: z.literal(this.config.connectionId),
      chatJid: z.string().regex(/^[^@\s]+@g\.us$/),
      messageId: z.string().min(1),
      historyMessageEncrypted: z.instanceof(Buffer),
    }).parse(row);
    const value: unknown = JSON.parse(decryptToString(row.historyMessageEncrypted, this.config.dataEncryptionKey), BufferJSON.reviver);
    const message = parseHistoryMessage(value);
    if (!message || message.key.remoteJid !== row.chatJid || message.key.id !== row.messageId) {
      throw new Error("Invalid stored history message");
    }
    const parsed = this.parseMessage(message);
    if (!parsed) return null;
    parsed.ts = row.ts;
    parsed.senderJid = row.senderJid;
    parsed.senderPhoneE164 = row.senderPhoneE164;
    parsed.mentionsSelf = false;
    const normalized = { ...message, message: normalizeMessageContent(message.message) };
    parsed.msgType = classifyMessage(normalized);
    try {
      const result = this.live.sock
        ? await this.media.download(normalized, this.live.sock)
        : { status: hasMedia(normalized) ? "failed" as const : "none" as const, media: null };
      parsed.mediaStatus = result.status;
      parsed.media = result.media;
    } catch {
      parsed.mediaStatus = "failed";
    }
    this.messages.setHistoryMediaStatus(row.connectionId, row.chatJid, row.messageId, parsed.mediaStatus);
    return parsed;
  }

  private onConnectionUpdate(u: {
    connection?: string;
    lastDisconnect?: { error?: Error } | undefined;
  }): void {
    const { connection, lastDisconnect } = u;

    if (connection === "open") {
      this.live.linkAttempts = 0;
      this.live.loggedOutRetries = 0;
      this.live.pairingCode = undefined;
      const first = this.live.linkedAtMs == null;
      const linkedAtMs = this.live.linkedAtMs ?? Date.now();
      this.live.linkedAtMs = linkedAtMs;
      this.live.status = "linked";
      this.upsertConnectionRow("linked", linkedAtMs);
      if (first) {
        this.log.info("connection linked");
        this.hooks.onLinked?.(this.config.connectionId, linkedAtMs);
      }
      return;
    }

    if (connection === "close") {
      const statusCode =
        (lastDisconnect?.error as Boom | undefined)?.output?.statusCode ??
        (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
      this.handleClose(statusCode);
    }
  }

  private handleClose(statusCode: number | undefined): void {
    if (this.live.stopped) return;

    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
    const everLinked = this.live.linkedAtMs != null;

    if (isLoggedOut && everLinked) {
      this.live.loggedOutRetries += 1;
      if (this.live.loggedOutRetries >= MAX_LOGGEDOUT_RETRIES) {
        // The saved session keeps being rejected — treat as a genuine unlink.
        this.live.status = "logged_out";
        this.upsertConnectionRow("logged_out");
        this.live.stopped = true;
        this.log.error("logged out — human must re-link, NOT auto-relinking", {
          loggedOutRetries: this.live.loggedOutRetries,
        });
        this.hooks.onLoggedOut?.(this.config.connectionId);
        return;
      }
    } else if (!everLinked) {
      // Still pairing: transient closes (incl. a 401 mid-pairing) retry up to a cap.
      this.live.linkAttempts += 1;
      if (this.live.linkAttempts >= MAX_LINK_ATTEMPTS) {
        this.log.error("gave up linking after max attempts", {
          attempts: MAX_LINK_ATTEMPTS,
        });
        this.live.stopped = true;
        return;
      }
    }

    // Reconnect with capped exponential backoff.
    const attempt = everLinked ? this.live.loggedOutRetries : this.live.linkAttempts;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    // A non-loggedOut close on a linked connection resets the loggedOut counter.
    if (everLinked && !isLoggedOut) this.live.loggedOutRetries = 0;
    setTimeout(() => {
      void this.openSocket();
    }, backoff);
  }

  private async onMessagesUpsert(
    up: { messages: WAMessage[]; type: string },
    sock: WASocket,
    epochs = new Map(this.groupEpochs),
  ): Promise<void> {
    if (up.type !== "notify" && up.type !== "append") return;
    for (const message of up.messages) {
      try {
        const parsed = this.parseMessage(message, sock.user);
        if (!parsed) continue;

        // Capture once even before activation. A duplicate of an old, capture-
        // only message must not become a backfill after the first tag/rejoin.
        const captured = this.messages.capture(parsed);
        if (!captured && parsed.isGroup) continue;
        if (parsed.fromMe && (!parsed.isGroup ||
          this.outboundLog.isGatewayMessage(parsed.connectionId, parsed.chatJid, parsed.messageId))) continue;
        const stale = () => parsed.isGroup &&
          (epochs.get(parsed.chatJid) ?? 0) !== (this.groupEpochs.get(parsed.chatJid) ?? 0);
        if (stale()) continue;

        // Group media is marker + caption, with no attachment allocation.
        // Preserve transient file delivery for DMs.
        if (!parsed.isGroup) {
          const { status, media } = await this.media.download(message, sock);
          parsed.mediaStatus = status;
          parsed.media = media;
        }
        if (stale()) continue;
        try {
          // Await the handoff so this upsert batch does not retain several
          // attachment buffers while PromptQL accepts/retries earlier ones.
          await this.hooks.onInbound?.(parsed);
        } finally {
          // The downloader owns this transient buffer and always releases it,
          // even if routing or MCP submission fails.
          parsed.media = null;
        }
      } catch (err) {
        this.log.error("inbound message handling failed", { err });
      }
    }
  }

  private parseMessage(m: WAMessage, user: unknown = this.live.sock?.user): InboundMessage | null {
    const chatJid = m.key.remoteJid;
    if (!chatJid) return null;
    const messageId = m.key.id;
    if (!messageId) return null;
    const fromMe = Boolean(m.key.fromMe);
    const isGroup = isGroupJid(chatJid);
    // In a group, participant is the real sender; in a DM it's the chat jid.
    const senderJid = fromMe
      ? ([...ownJids(user)].find((jid) => phoneE164FromJid(jid)) ?? m.key.participant ?? chatJid)
      : isGroup ? (m.key.participant ?? chatJid) : chatJid;

    // LID addressing: when WhatsApp delivers over a LID (`<id>@lid`), the sender
    // jid carries NO phone number. Baileys surfaces the phone-number (`@s.what...`)
    // counterpart on the *Alt fields of the key — `remoteJidAlt` for a DM,
    // `participantAlt` for a group participant. Prefer that for phone derivation
    // so sender-based routing still resolves; fall back to the sender jid itself
    // when it already carries the phone (pn addressing).
    const phoneBearingJid = isGroup
      ? (m.key.participantAlt ?? senderJid)
      : (m.key.remoteJidAlt ?? senderJid);
    const senderPhoneE164 = fromMe
      ? phoneE164FromJid(senderJid)
      : phoneE164FromJid(phoneBearingJid) ?? phoneE164FromJid(senderJid);

    // LID observability. Sender-based routing depends on recovering a phone from
    // the *Alt field of a LID-addressed message. Keep a durable signal for it:
    //  - success is `debug` (off at info): quiet unless you are diagnosing.
    //  - FAILURE is `warn`: a LID message with no derivable phone will drop as
    //    `unmapped` with no other explanation. This line is how you find out WA
    //    stopped populating the alt (or shipped a new addressing variant), rather
    //    than a real shopper's message silently vanishing.
    const isLid = isLidJid(senderJid) || m.key.addressingMode === "lid";
    if (isLid && !senderPhoneE164) {
      this.log.warn("lid message: no phone derivable (will not sender-resolve)", {
        addressingMode: m.key.addressingMode,
        senderJid: maskJid(senderJid),
        hasRemoteJidAlt: Boolean(m.key.remoteJidAlt),
        hasParticipantAlt: Boolean(m.key.participantAlt),
      });
    } else if (isLid) {
      this.log.debug("lid message: resolved phone from alt jid", {
        derivedPhone: maskNumber(senderPhoneE164),
      });
    }

    const text = extractText(m);
    const ts = Number(m.messageTimestamp ?? 0) * 1000 || Date.now();
    return {
      connectionId: this.config.connectionId,
      chatJid,
      senderJid,
      senderPhoneE164,
      messageId,
      ts,
      text,
      msgType: classifyMessage(m),
      mediaStatus: "none",
      media: null,
      isGroup,
      fromMe,
      mentionsSelf: mentionsSelf(m, user),
    };
  }


  /**
   * Send a text message through the anti-ban queue. Returns the Baileys message
   * key id on success. Never call sock.sendMessage directly — always go through
   * this so pacing/presence/serialization apply.
   */
  async sendText(
    chatJid: string,
    text: string,
    options: {
      pacingProfile?: PacingProfile;
      beforeSend?: () => boolean;
      onMessageId?: (id: string) => void;
    } = {},
  ): Promise<string> {
    const { pacingProfile } = z.object({
      chatJid: z.string().min(1),
      text: z.string().min(1),
      pacingProfile: PacingProfileSchema.optional(),
    }).parse({ chatJid, text, pacingProfile: options.pacingProfile });
    const sock = this.live.sock;
    if (!sock || this.live.status !== "linked") {
      throw new Error(`connection ${this.config.connectionId} is not linked`);
    }
    const ctx: SendContext = {
      connectionId: this.config.connectionId,
      chatJid,
      textLength: text.length,
      pacingProfile,
      linkedAtMs: this.live.linkedAtMs,
      setComposing: async () => {
        await sock.sendPresenceUpdate("composing", chatJid);
      },
      clearComposing: async () => {
        await sock.sendPresenceUpdate("paused", chatJid);
      },
    };
    return this.antiBan.enqueue(ctx, async () => {
      // Re-check after anti-ban pacing, not only when dispatch began.
      if (options.beforeSend && !options.beforeSend()) throw new Error("chat_left");
      const messageId = generateMessageIDV2(sock.user?.id);
      // Persist before sendMessage can emit our own echo.
      options.onMessageId?.(messageId);
      const sent = await sock.sendMessage(chatJid, { text }, { messageId });
      const parsed = z.object({ key: z.object({ id: z.string().min(1) }) }).parse(sent);
      return parsed.key.id;
    });
  }
}

/** Extract plain text from the common WAMessage shapes. */
function extractText(m: WAMessage): string {
  const msg = normalizeMessageContent(m.message);
  if (!msg) return "";
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    ""
  );
}

/** Exposed for the router's debug logging. */
export function describeSender(msg: InboundMessage): string {
  return `${maskJid(msg.senderJid)} (${jidUser(msg.chatJid).slice(0, 4)}...)`;
}
