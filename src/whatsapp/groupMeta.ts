/**
 * SQLite group metadata. Ported from the reference `hasura/whatsapp-gateway`.
 *
 * Persists group subject + participants and feeds Baileys' `cachedGroupMetadata`
 * (anti-ban: avoid refetch/re-encrypt per send). Refreshed on `groups.update` /
 * `group-participants.update` and lazily on cache miss / staleness
 * (TTL = WHATSAPP_GROUP_META_TTL_MS).
 */

import type { Database } from "bun:sqlite";
import type { GroupMetadata, WASocket } from "baileys";
import { nowIso, phoneE164FromJid } from "../util.ts";

export interface GroupParticipant {
  jid: string;
  phone_e164: string | null;
  admin: boolean;
}

export interface StoredGroupMetadata {
  groupJid: string;
  subject: string | null;
  participants: GroupParticipant[];
  updatedAt: string;
}

interface GroupMetadataRow {
  group_jid: string;
  subject: string | null;
  participants: string | null;
  raw_metadata: string | null;
  updated_at: string;
}

function toParticipants(meta: GroupMetadata): GroupParticipant[] {
  return meta.participants.map((p) => ({
    jid: p.id,
    // In lid-addressed groups `p.id` is the opaque `@lid` (no phone in it), but
    // Baileys 7 supplies the member's PN jid alongside as `p.phoneNumber`
    // (`<phone>@s.whatsapp.net`). Prefer that for the phone.
    phone_e164: phoneE164FromJid(p.phoneNumber ?? p.id),
    admin: p.admin === "admin" || p.admin === "superadmin",
  }));
}

export class GroupMetaStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
  ) {}

  /** Persist metadata from a Baileys GroupMetadata object. */
  upsert(connectionId: string, meta: GroupMetadata): void {
    const participants = toParticipants(meta);
    this.db.run(
      `INSERT INTO whatsapp_group_metadata
         (connection_id, group_jid, subject, participants, raw_metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, group_jid) DO UPDATE SET
         subject = excluded.subject,
         participants = excluded.participants,
         raw_metadata = excluded.raw_metadata,
         updated_at = excluded.updated_at`,
      [
        connectionId,
        meta.id,
        meta.subject ?? null,
        JSON.stringify(participants),
        JSON.stringify(meta),
        nowIso(),
      ],
    );
  }

  /** Apply a partial `groups.update` event (subject changes etc.). */
  applyPartialUpdate(
    connectionId: string,
    groupJid: string,
    patch: Partial<{ subject: string }>,
  ): void {
    const existing = this.read(connectionId, groupJid);
    if (!existing) return; // will be lazily fetched on next need
    if (patch.subject !== undefined) {
      this.db.run(
        `UPDATE whatsapp_group_metadata SET subject = ?, updated_at = ?
         WHERE connection_id = ? AND group_jid = ?`,
        [patch.subject, nowIso(), connectionId, groupJid],
      );
    }
  }

  read(connectionId: string, groupJid: string): StoredGroupMetadata | null {
    const row = this.db
      .query<GroupMetadataRow, [string, string]>(
        `SELECT group_jid, subject, participants, raw_metadata, updated_at
         FROM whatsapp_group_metadata
         WHERE connection_id = ? AND group_jid = ?`,
      )
      .get(connectionId, groupJid);
    if (!row) return null;
    return {
      groupJid: row.group_jid,
      subject: row.subject,
      participants: row.participants ? JSON.parse(row.participants) : [],
      updatedAt: row.updated_at,
    };
  }

  private isStale(updatedAt: string): boolean {
    return Date.now() - new Date(updatedAt).getTime() > this.ttlMs;
  }

  /** Read metadata, fetching fresh from the socket on miss or staleness. */
  async readOrFetch(
    connectionId: string,
    groupJid: string,
    sock: Pick<WASocket, "groupMetadata">,
  ): Promise<StoredGroupMetadata | null> {
    const cached = this.read(connectionId, groupJid);
    if (cached && !this.isStale(cached.updatedAt)) return cached;
    try {
      const fresh = await sock.groupMetadata(groupJid);
      this.upsert(connectionId, fresh);
      return this.read(connectionId, groupJid);
    } catch (err) {
      console.warn(
        `[groupMeta] fetch failed conn=${connectionId} group=${groupJid}: ${String(err)}`,
      );
      return cached; // serve stale rather than nothing
    }
  }

  /**
   * cachedGroupMetadata provider for makeWASocket (anti-ban). Returns the raw
   * Baileys GroupMetadata shape from raw_metadata when fresh enough, else
   * undefined so Baileys refetches.
   */
  cachedGroupMetadataProvider(
    connectionId: string,
  ): (jid: string) => Promise<GroupMetadata | undefined> {
    return async (jid: string) => {
      const row = this.db
        .query<GroupMetadataRow, [string, string]>(
          `SELECT group_jid, subject, participants, raw_metadata, updated_at
           FROM whatsapp_group_metadata
           WHERE connection_id = ? AND group_jid = ?`,
        )
        .get(connectionId, jid);
      if (!row?.raw_metadata) return undefined;
      if (this.isStale(row.updated_at)) return undefined; // force Baileys to refetch
      try {
        return JSON.parse(row.raw_metadata) as GroupMetadata;
      } catch {
        return undefined;
      }
    };
  }
}
