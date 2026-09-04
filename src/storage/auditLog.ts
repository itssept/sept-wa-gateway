/**
 * Auditable management events. Every create/rotate/revoke/disable/mapping change
 * is recorded here. The `detail` JSON MUST NOT contain raw secrets — pass a
 * fingerprint or a non-secret ref instead.
 */

import type { Database } from "bun:sqlite";
import { nowIso, uuid } from "../util.ts";

export type AuditAction =
  | "shopper.create"
  | "shopper.disable"
  | "shopper.enable"
  | "credential.rotate"
  | "credential.revoke"
  | "mapping.upsert"
  | "mapping.disable"
  | "mapping.enable"
  | "connection.link"
  | "connection.logged_out"
  | "inbound.rejected";

export interface AuditEntry {
  id: string;
  ts: string;
  action: AuditAction;
  actor: string;
  subjectType: string | null;
  subjectId: string | null;
  detail: Record<string, unknown> | null;
}

export class AuditLog {
  constructor(private readonly db: Database) {}

  record(
    action: AuditAction,
    opts: {
      actor?: string;
      subjectType?: string;
      subjectId?: string;
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO audit_log (id, ts, action, actor, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        ts,
        action,
        opts.actor ?? "admin",
        opts.subjectType ?? null,
        opts.subjectId ?? null,
        opts.detail ? JSON.stringify(opts.detail) : null,
        ts,
      ],
    );
  }

  recent(limit = 100): AuditEntry[] {
    interface Row {
      id: string;
      ts: string;
      action: string;
      actor: string;
      subject_type: string | null;
      subject_id: string | null;
      detail: string | null;
    }
    return this.db
      .query<Row, [number]>("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action as AuditAction,
        actor: r.actor,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      }));
  }
}
