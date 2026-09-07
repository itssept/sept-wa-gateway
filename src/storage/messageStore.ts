/**
 * Capture-all WhatsApp message repository.
 *
 * Message text and transport metadata are persisted for loop prevention and
 * debugging. Media bytes are transient and never enter SQLite.
 */

import type { Database } from "bun:sqlite";
import { nowIso } from "../util.ts";

export interface CapturedMessage {
  connectionId: string;
  chatJid: string;
  senderJid: string;
  senderPhoneE164: string | null;
  messageId: string;
  ts: number;
  msgType: string;
  text: string;
  fromMe: boolean;
}

export class MessageStore {
  constructor(private readonly db: Database) {}

  capture(message: CapturedMessage): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO whatsapp_message_store
         (id, connection_id, chat_jid, sender_jid, sender_phone_e164,
          message_id, ts, msg_type, text, from_me, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        message.connectionId,
        message.chatJid,
        message.senderJid,
        message.senderPhoneE164,
        message.messageId,
        message.ts,
        message.msgType,
        message.text,
        message.fromMe ? 1 : 0,
        nowIso(),
      ],
    );
    return result.changes > 0;
  }
}
