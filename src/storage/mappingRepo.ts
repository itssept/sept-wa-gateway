/**
 * Chat mapping repository: WhatsApp chat/group jid -> shopper. A jid maps to at
 * most one shopper (the PK enforces it), so resolution is never ambiguous.
 */

import type { Database } from "bun:sqlite";
import type { ChatMapping, MappingStatus } from "../domain/types.ts";
import { nowIso } from "../util.ts";

interface Row {
  connection_id: string;
  chat_jid: string;
  shopper_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toMapping(r: Row): ChatMapping {
  return {
    connectionId: r.connection_id,
    chatJid: r.chat_jid,
    shopperId: r.shopper_id,
    status: r.status as MappingStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class MappingRepo {
  constructor(private readonly db: Database) {}

  /** Upsert a mapping (connection_id, chat_jid) -> shopper. */
  upsert(
    connectionId: string,
    chatJid: string,
    shopperId: string,
    status: MappingStatus = "enabled",
  ): ChatMapping {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO chat_mapping
         (connection_id, chat_jid, shopper_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, chat_jid)
       DO UPDATE SET shopper_id = excluded.shopper_id,
                     status = excluded.status,
                     updated_at = excluded.updated_at`,
      [connectionId, chatJid, shopperId, status, ts, ts],
    );
    return this.get(connectionId, chatJid)!;
  }

  get(connectionId: string, chatJid: string): ChatMapping | null {
    const r = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM chat_mapping WHERE connection_id = ? AND chat_jid = ?",
      )
      .get(connectionId, chatJid);
    return r ? toMapping(r) : null;
  }

  list(connectionId?: string): ChatMapping[] {
    const rows = connectionId
      ? this.db
          .query<Row, [string]>(
            "SELECT * FROM chat_mapping WHERE connection_id = ? ORDER BY created_at ASC",
          )
          .all(connectionId)
      : this.db
          .query<Row, []>("SELECT * FROM chat_mapping ORDER BY created_at ASC")
          .all();
    return rows.map(toMapping);
  }

  setStatus(
    connectionId: string,
    chatJid: string,
    status: MappingStatus,
  ): ChatMapping | null {
    const existing = this.get(connectionId, chatJid);
    if (!existing) return null;
    this.db.run(
      "UPDATE chat_mapping SET status = ?, updated_at = ? WHERE connection_id = ? AND chat_jid = ?",
      [status, nowIso(), connectionId, chatJid],
    );
    return this.get(connectionId, chatJid);
  }
}
