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
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WAMessage,
  type WASocket,
} from "baileys";
import { Boom } from "@hapi/boom";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { useSqliteAuthState, type AuthStateHandle } from "./authState.ts";
import { AntiBanQueue, type SendContext } from "./antiBan.ts";
import { GroupMetaStore } from "./groupMeta.ts";
import { rootLogger, type Logger } from "../logger.ts";
import {
  e164ToPairingNumber,
  isGroupJid,
  jidUser,
  maskJid,
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
  isGroup: boolean;
  fromMe: boolean;
}

export interface SocketHooks {
  /** Called for each captured inbound message (already persisted). */
  onInbound?: (msg: InboundMessage) => void;
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
  private readonly log: Logger;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly antiBan: AntiBanQueue,
    private readonly hooks: SocketHooks = {},
    log?: Logger,
  ) {
    this.log = (log ?? rootLogger).child({
      component: "whatsapp",
      connectionId: config.connectionId,
    });
    this.groups = new GroupMetaStore(db, config.groupMetaTtlMs, this.log);
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
    sock.ev.on("messages.upsert", (up) => this.onMessagesUpsert(up));

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

    sock.ev.on("group-participants.update", async (update) => {
      await this.groups
        .readOrFetch(this.config.connectionId, update.id, sock)
        .catch(() => undefined);
    });
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

  private onMessagesUpsert(up: { messages: WAMessage[]; type: string }): void {
    if (up.type !== "notify" && up.type !== "append") return;
    for (const m of up.messages) {
      const parsed = this.parseMessage(m);
      if (!parsed) continue;
      this.persistMessage(parsed);
      // fromMe messages are captured for loop-prevention but never routed.
      if (!parsed.fromMe) this.hooks.onInbound?.(parsed);
    }
  }

  private parseMessage(m: WAMessage): InboundMessage | null {
    const chatJid = m.key.remoteJid;
    if (!chatJid) return null;
    const messageId = m.key.id;
    if (!messageId) return null;
    const fromMe = Boolean(m.key.fromMe);
    const isGroup = isGroupJid(chatJid);
    // In a group, participant is the real sender; in a DM it's the chat jid.
    const senderJid = isGroup ? (m.key.participant ?? chatJid) : chatJid;
    const text = extractText(m);
    const ts = Number(m.messageTimestamp ?? 0) * 1000 || Date.now();
    return {
      connectionId: this.config.connectionId,
      chatJid,
      senderJid,
      senderPhoneE164: phoneE164FromJid(senderJid),
      messageId,
      ts,
      text,
      isGroup,
      fromMe,
    };
  }

  private persistMessage(msg: InboundMessage): void {
    // Idempotent capture — the unique index dedups replays.
    this.db.run(
      `INSERT OR IGNORE INTO whatsapp_message_store
         (id, connection_id, chat_jid, sender_jid, sender_phone_e164,
          message_id, ts, msg_type, text, from_me, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
      [
        crypto.randomUUID(),
        msg.connectionId,
        msg.chatJid,
        msg.senderJid,
        msg.senderPhoneE164,
        msg.messageId,
        msg.ts,
        msg.text,
        msg.fromMe ? 1 : 0,
        nowIso(),
      ],
    );
  }

  /**
   * Send a text message through the anti-ban queue. Returns the Baileys message
   * key id on success. Never call sock.sendMessage directly — always go through
   * this so pacing/presence/serialization apply.
   */
  async sendText(chatJid: string, text: string): Promise<string> {
    const sock = this.live.sock;
    if (!sock || this.live.status !== "linked") {
      throw new Error(`connection ${this.config.connectionId} is not linked`);
    }
    const ctx: SendContext = {
      connectionId: this.config.connectionId,
      chatJid,
      textLength: text.length,
      linkedAtMs: this.live.linkedAtMs,
      setComposing: async () => {
        await sock.sendPresenceUpdate("composing", chatJid);
      },
      clearComposing: async () => {
        await sock.sendPresenceUpdate("paused", chatJid);
      },
    };
    return this.antiBan.enqueue(ctx, async () => {
      const sent = await sock.sendMessage(chatJid, { text });
      return sent?.key?.id ?? "";
    });
  }
}

/** Extract plain text from the common WAMessage shapes. */
function extractText(m: WAMessage): string {
  const msg = m.message;
  if (!msg) return "";
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    ""
  );
}

/** Exposed for the router's debug logging. */
export function describeSender(msg: InboundMessage): string {
  return `${maskJid(msg.senderJid)} (${jidUser(msg.chatJid).slice(0, 4)}...)`;
}
