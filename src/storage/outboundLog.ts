/**
 * Outbound send idempotency. Keyed on (connection_id, idempotency_key), where
 * idempotency_key is the inbound WhatsApp message id that produced the response.
 * A retry of the same inbound therefore never double-sends.
 *
 * Flow: claim() atomically reserves the key (or reclaims a stale 'pending' row),
 * returning a claim_token. markSent()/markFailed() only apply if the token still
 * matches — so a reclaiming retry and the original sender cannot clobber each
 * other's terminal write.
 */

import type { Database } from "bun:sqlite";
import { nowIso, uuid } from "../util.ts";

const STALE_PENDING_MS = 2 * 60 * 1000;

export type ClaimResult =
  | { status: "claimed"; token: string }
  | { status: "already_sent"; ref: string | null }
  | { status: "in_flight" };

export class OutboundLog {
  constructor(private readonly db: Database) {}

  /**
   * Reserve the key for sending. Returns:
   *  - claimed      → caller owns the send; use the token on the terminal write
   *  - already_sent → a prior send succeeded; do nothing (dedup)
   *  - in_flight    → another sender holds a fresh pending claim; skip
   */
  claim(connectionId: string, idempotencyKey: string): ClaimResult {
    const token = uuid();
    const ts = nowIso();
    interface Row {
      status: string;
      claim_token: string | null;
      whatsapp_message_ref: string | null;
      updated_at: string;
    }
    const tx = this.db.transaction((): ClaimResult => {
      const existing = this.db
        .query<Row, [string, string]>(
          "SELECT status, claim_token, whatsapp_message_ref, updated_at FROM whatsapp_outbound_log WHERE connection_id = ? AND idempotency_key = ?",
        )
        .get(connectionId, idempotencyKey);

      if (!existing) {
        this.db.run(
          `INSERT INTO whatsapp_outbound_log
             (connection_id, idempotency_key, status, claim_token, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?)`,
          [connectionId, idempotencyKey, token, ts, ts],
        );
        return { status: "claimed", token };
      }
      if (existing.status === "sent") {
        return { status: "already_sent", ref: existing.whatsapp_message_ref };
      }
      // pending or failed: reclaim only if stale (crashed sender) or failed.
      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      const reclaimable = existing.status === "failed" || ageMs > STALE_PENDING_MS;
      if (!reclaimable) return { status: "in_flight" };
      this.db.run(
        `UPDATE whatsapp_outbound_log
           SET status = 'pending', claim_token = ?, updated_at = ?
         WHERE connection_id = ? AND idempotency_key = ?`,
        [token, ts, connectionId, idempotencyKey],
      );
      return { status: "claimed", token };
    });
    return tx();
  }

  markSent(
    connectionId: string,
    idempotencyKey: string,
    token: string,
    ref: { chatJid: string; messageRef: string },
  ): boolean {
    const res = this.db.run(
      `UPDATE whatsapp_outbound_log
         SET status = 'sent', chat_jid = ?, whatsapp_message_ref = ?, updated_at = ?
       WHERE connection_id = ? AND idempotency_key = ? AND claim_token = ?`,
      [ref.chatJid, ref.messageRef, nowIso(), connectionId, idempotencyKey, token],
    );
    return res.changes > 0;
  }

  markFailed(connectionId: string, idempotencyKey: string, token: string): boolean {
    const res = this.db.run(
      `UPDATE whatsapp_outbound_log
         SET status = 'failed', updated_at = ?
       WHERE connection_id = ? AND idempotency_key = ? AND claim_token = ?`,
      [nowIso(), connectionId, idempotencyKey, token],
    );
    return res.changes > 0;
  }
}
