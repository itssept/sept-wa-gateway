/**
 * Per-chat PromptQL bot (thread) handle store. Gives conversational continuity:
 * a chat's first message starts a bot; later messages continue the same one.
 */

import { z } from "zod";
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
  relayPausedAt: string | null;
}

const RowSchema = z.object({
  connection_id: z.string(),
  chat_jid: z.string(),
  shopper_id: z.string(),
  thread_id: z.string(),
  room_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  relay_paused_at: z.string().nullable(),
});
type Row = z.infer<typeof RowSchema>;
const KeySchema = z.tuple([z.string().min(1), z.string().min(1)]);

function toChatBot(r: Row): ChatBot {
  return {
    connectionId: r.connection_id,
    chatJid: r.chat_jid,
    shopperId: r.shopper_id,
    threadId: r.thread_id,
    roomName: r.room_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    relayPausedAt: r.relay_paused_at,
  };
}

export class ChatBotRepo {
  constructor(private readonly db: Database) {}

  get(connectionId: string, chatJid: string): ChatBot | null {
    KeySchema.parse([connectionId, chatJid]);
    const r = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM chat_bot WHERE connection_id = ? AND chat_jid = ?",
      )
      .get(connectionId, chatJid);
    return r ? toChatBot(RowSchema.parse(r)) : null;
  }

  /** Membership changes are local only. No bot is created and no MCP call runs. */
  pauseRelay(connectionId: string, chatJid: string): void {
    KeySchema.parse([connectionId, chatJid]);
    const ts = nowIso();
    this.db.run(
      "UPDATE chat_bot SET relay_paused_at = ?, updated_at = ? WHERE connection_id = ? AND chat_jid = ?",
      [ts, ts, connectionId, chatJid],
    );
  }

  /** Record (or update) the bot handle for a chat. */
  upsert(input: {
    connectionId: string;
    chatJid: string;
    shopperId: string;
    threadId: string;
    roomName?: string | null;
    relayPausedAt?: string | null;
  }): ChatBot {
    z.object({
      connectionId: z.string().min(1), chatJid: z.string().min(1),
      shopperId: z.string().min(1), threadId: z.string().min(1),
      roomName: z.string().nullable().optional(),
      relayPausedAt: z.string().nullable().optional(),
    }).parse(input);
    const ts = nowIso();
    this.db.run(
      `INSERT INTO chat_bot
         (connection_id, chat_jid, shopper_id, thread_id, room_name, created_at, updated_at, relay_paused_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, chat_jid)
       DO UPDATE SET thread_id = excluded.thread_id,
                     shopper_id = excluded.shopper_id,
                     room_name = excluded.room_name,
                     updated_at = excluded.updated_at,
                     relay_paused_at = excluded.relay_paused_at`,
      [
        input.connectionId,
        input.chatJid,
        input.shopperId,
        input.threadId,
        input.roomName ?? null,
        ts,
        ts,
        input.relayPausedAt ?? null,
      ],
    );
    return this.get(input.connectionId, input.chatJid)!;
  }
}
