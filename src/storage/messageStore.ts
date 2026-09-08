/**
 * Capture-all WhatsApp message repository. Media bytes are transient; history
 * rows retain an encrypted transport envelope so replay can retrieve media.
 */
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { nowIso } from "../util.ts";

const MessageKey = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
const HistoryMediaStatus = z.enum(["none", "pending", "ready", "failed", "expired", "too_large"]);
const Captured = z.object({
  connectionId: z.string().min(1),
  chatJid: z.string().min(1),
  senderJid: z.string().min(1),
  senderPhoneE164: z.string().nullable(),
  messageId: z.string().min(1),
  ts: z.number().int().nonnegative().safe(),
  msgType: z.string(),
  text: z.string(),
  fromMe: z.boolean(),
});
export type CapturedMessage = z.infer<typeof Captured>;

const HistoryRow = Captured.extend({
  isHistory: z.literal(1).transform(() => true as const),
  historyMessageEncrypted: z.instanceof(Uint8Array).transform((v) => Buffer.from(v)),
  historyMediaStatus: HistoryMediaStatus,
  relayedAt: z.string().nullable(),
});
export type StoredHistoryMessage = z.infer<typeof HistoryRow>;

export class MessageStore {
  constructor(private readonly db: Database) {}

  capture(message: CapturedMessage): boolean {
    return this.insert(message, null, "none");
  }

  /** Never promote an existing live row to history, even after a remove/re-add. */
  captureHistory(
    message: CapturedMessage,
    historyMessageEncrypted: Buffer,
    mediaStatus: StoredHistoryMessage["historyMediaStatus"],
  ): boolean {
    z.instanceof(Buffer).refine((v) => v.length > 28).parse(historyMessageEncrypted);
    HistoryMediaStatus.parse(mediaStatus);
    return this.insert(message, historyMessageEncrypted, mediaStatus);
  }

  private insert(
    input: CapturedMessage,
    envelope: Buffer | null,
    mediaStatus: StoredHistoryMessage["historyMediaStatus"],
  ): boolean {
    const message = Captured.parse(input);
    const result = this.db.run(
      `INSERT OR IGNORE INTO whatsapp_message_store
         (id, connection_id, chat_jid, sender_jid, sender_phone_e164,
          message_id, ts, msg_type, text, from_me, created_at,
          is_history, history_message_encrypted, history_media_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), message.connectionId, message.chatJid,
        message.senderJid, message.senderPhoneE164, message.messageId,
        message.ts, message.msgType, message.text, message.fromMe ? 1 : 0,
        nowIso(), envelope ? 1 : 0, envelope, mediaStatus,
      ],
    );
    return result.changes > 0;
  }

  /** Call only after the downstream relay has accepted the message. */
  markRelayed(connectionId: string, chatJid: string, messageId: string): boolean {
    MessageKey.parse([connectionId, chatJid, messageId]);
    return this.db.run(
      `UPDATE whatsapp_message_store SET relayed_at = COALESCE(relayed_at, ?)
       WHERE connection_id = ? AND chat_jid = ? AND message_id = ?`,
      [nowIso(), connectionId, chatJid, messageId],
    ).changes > 0;
  }

  setHistoryMediaStatus(
    connectionId: string, chatJid: string, messageId: string,
    status: StoredHistoryMessage["historyMediaStatus"],
  ): void {
    MessageKey.parse([connectionId, chatJid, messageId]);
    HistoryMediaStatus.parse(status);
    this.db.run(
      `UPDATE whatsapp_message_store SET history_media_status = ?
       WHERE connection_id = ? AND chat_jid = ? AND message_id = ? AND is_history = 1`,
      [status, connectionId, chatJid, messageId],
    );
  }

  listUnrelayedHistory(connectionId: string, groupJid: string): StoredHistoryMessage[] {
    z.tuple([z.string().min(1), z.string().regex(/^[^@\s]+@g\.us$/)])
      .parse([connectionId, groupJid]);
    const rows = this.db.query<Record<string, unknown>, [string, string]>(
      `SELECT connection_id AS connectionId, chat_jid AS chatJid,
         sender_jid AS senderJid, sender_phone_e164 AS senderPhoneE164,
         message_id AS messageId, ts, msg_type AS msgType, COALESCE(text, '') AS text,
         from_me AS fromMe, is_history AS isHistory,
         history_message_encrypted AS historyMessageEncrypted,
         history_media_status AS historyMediaStatus, relayed_at AS relayedAt
       FROM whatsapp_message_store
       WHERE connection_id = ? AND chat_jid = ? AND is_history = 1 AND relayed_at IS NULL
       ORDER BY ts ASC, rowid ASC`,
    ).all(connectionId, groupJid);
    return rows.map((row) => HistoryRow.parse({
      ...row,
      fromMe: z.union([z.literal(0), z.literal(1)]).parse(row.fromMe) === 1,
    }));
  }
}
