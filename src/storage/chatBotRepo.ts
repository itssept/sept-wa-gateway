/**
 * Per-chat PromptQL bot (thread) handle store. Gives conversational continuity:
 * a chat's first message starts a bot; later messages continue the same one.
 */

import type { Database } from "bun:sqlite";
import { nowIso } from "../util.ts";

export interface ChatBot {
  connectionId: string;
  chatJid: string;
  shopperId: string;
  threadId: string;
  roomName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  connection_id: string;
  chat_jid: string;
  shopper_id: string;
  thread_id: string;
  room_name: string | null;
  created_at: string;
  updated_at: string;
}

function toChatBot(r: Row): ChatBot {
  return {
    connectionId: r.connection_id,
    chatJid: r.chat_jid,
    shopperId: r.shopper_id,
    threadId: r.thread_id,
    roomName: r.room_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ChatBotRepo {
  constructor(private readonly db: Database) {}

  get(connectionId: string, chatJid: string): ChatBot | null {
    const r = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM chat_bot WHERE connection_id = ? AND chat_jid = ?",
      )
      .get(connectionId, chatJid);
    return r ? toChatBot(r) : null;
  }

  /** Record (or update) the bot handle for a chat. */
  upsert(input: {
    connectionId: string;
    chatJid: string;
    shopperId: string;
    threadId: string;
    roomName?: string | null;
  }): ChatBot {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO chat_bot
         (connection_id, chat_jid, shopper_id, thread_id, room_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, chat_jid)
       DO UPDATE SET thread_id = excluded.thread_id,
                     shopper_id = excluded.shopper_id,
                     room_name = excluded.room_name,
                     updated_at = excluded.updated_at`,
      [
        input.connectionId,
        input.chatJid,
        input.shopperId,
        input.threadId,
        input.roomName ?? null,
        ts,
        ts,
      ],
    );
    return this.get(input.connectionId, input.chatJid)!;
  }
}
