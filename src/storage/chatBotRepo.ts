/**
 * Per-chat PromptQL bot (thread) handle store. Gives conversational continuity:
 * a chat's first message starts a bot; later messages continue the same one.
 */

import { z } from "zod";
import type { Database } from "bun:sqlite";
import { encrypt, decryptToString } from "../crypto.ts";
import { PostingIdentitySchema } from "../promptql/promptqlAdapter.ts";
import { nowIso } from "../util.ts";

export interface ChatBot {
  connectionId: string;
  chatJid: string;
  shopperId: string | null;
  threadId: string;
  roomName: string | null;
  createdAt: string;
  updatedAt: string;
  relayPausedAt: string | null;
}

const RowSchema = z.object({
  connection_id: z.string(),
  chat_jid: z.string(),
  shopper_id: z.string().nullable(),
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

const PendingPostSchema = z.object({ identity: PostingIdentitySchema, query: z.string().min(1), messageId: z.string().min(1).optional() });
type PendingPost = z.infer<typeof PendingPostSchema>;

export class ChatBotRepo {
  constructor(private readonly db: Database, private readonly encryptionKey?: Buffer) {}

  membership(connectionId: string, chatJid: string) {
    KeySchema.parse([connectionId, chatJid]);
    const row = this.db.query("SELECT present, added_by_jid FROM chat_group_membership WHERE connection_id = ? AND chat_jid = ?").get(connectionId, chatJid);
    return row ? z.object({ present: z.union([z.literal(0), z.literal(1)]), added_by_jid: z.string().nullable() }).parse(row) : null;
  }

  setMembership(connectionId: string, chatJid: string, present: boolean, addedByJid?: string | null): void {
    KeySchema.parse([connectionId, chatJid]);
    z.boolean().parse(present);
    z.string().nullish().parse(addedByJid);
    this.db.run(`INSERT INTO chat_group_membership VALUES (?, ?, ?, ?)
      ON CONFLICT (connection_id, chat_jid) DO UPDATE SET
        present = excluded.present,
        added_by_jid = CASE WHEN chat_group_membership.present = 0 THEN excluded.added_by_jid
          ELSE COALESCE(chat_group_membership.added_by_jid, excluded.added_by_jid) END`,
      [connectionId, chatJid, present ? 1 : 0, addedByJid ?? null]);
    this.db.run("UPDATE chat_bot SET relay_paused_at = ?, updated_at = ? WHERE connection_id = ? AND chat_jid = ?",
      [present ? null : nowIso(), nowIso(), connectionId, chatJid]);
  }

  pendingPost(connectionId: string, chatJid: string): PendingPost | null {
    KeySchema.parse([connectionId, chatJid]);
    const row = this.db.query("SELECT pending_post_encrypted FROM chat_bot WHERE connection_id = ? AND chat_jid = ?").get(connectionId, chatJid);
    const parsed = z.object({ pending_post_encrypted: z.instanceof(Uint8Array).nullable() }).nullable().parse(row);
    if (!parsed?.pending_post_encrypted) return null;
    if (!this.encryptionKey) throw new Error("Pending post encryption is not configured");
    return PendingPostSchema.parse(JSON.parse(decryptToString(Buffer.from(parsed.pending_post_encrypted), this.encryptionKey)));
  }

  setPendingPost(connectionId: string, chatJid: string, post: PendingPost | null): void {
    KeySchema.parse([connectionId, chatJid]);
    if (post && !this.encryptionKey) throw new Error("Pending post encryption is not configured");
    const encrypted = post ? encrypt(JSON.stringify(PendingPostSchema.parse(post)), this.encryptionKey!) : null;
    this.db.run("UPDATE chat_bot SET pending_post_encrypted = ? WHERE connection_id = ? AND chat_jid = ?",
      [encrypted, connectionId, chatJid]);
  }

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
    shopperId: string | null;
    threadId: string;
    roomName?: string | null;
    relayPausedAt?: string | null;
  }): ChatBot {
    z.object({
      connectionId: z.string().min(1), chatJid: z.string().min(1),
      shopperId: z.string().min(1).nullable(), threadId: z.string().min(1),
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
