import type { Database } from "bun:sqlite";
import { nowIso } from "../util.ts";

export interface WelcomeRecord {
  shopperId: string;
  connectionId: string;
  welcomeSent: boolean;
  sentAt: string | null;
  feedbackPromptSent: boolean;
  feedbackPromptSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  shopper_id: string;
  connection_id: string;
  welcome_sent: number;
  sent_at: string | null;
  feedback_prompt_sent: number;
  feedback_prompt_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export class WelcomeLogRepo {
  constructor(private readonly db: Database) {}

  isWelcomeSent(shopperId: string, connectionId?: string): boolean {
    let r: Row | null = null;
    if (connectionId) {
      r = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM operator_welcome_log WHERE shopper_id = ? AND connection_id = ?",
        )
        .get(shopperId, connectionId);
    } else {
      r = this.db
        .query<Row, [string]>(
          "SELECT * FROM operator_welcome_log WHERE shopper_id = ? AND welcome_sent = 1",
        )
        .get(shopperId);
    }
    return Boolean(r && r.welcome_sent === 1);
  }

  getRecord(shopperId: string, connectionId: string): WelcomeRecord | null {
    const r = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM operator_welcome_log WHERE shopper_id = ? AND connection_id = ?",
      )
      .get(shopperId, connectionId);
    if (!r) return null;
    return {
      shopperId: r.shopper_id,
      connectionId: r.connection_id,
      welcomeSent: r.welcome_sent === 1,
      sentAt: r.sent_at,
      feedbackPromptSent: r.feedback_prompt_sent === 1,
      feedbackPromptSentAt: r.feedback_prompt_sent_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  isFeedbackPromptSent(shopperId: string, connectionId?: string): boolean {
    let r: Row | null = null;
    if (connectionId) {
      r = this.db
        .query<Row, [string, string]>(
          "SELECT * FROM operator_welcome_log WHERE shopper_id = ? AND connection_id = ?",
        )
        .get(shopperId, connectionId);
    } else {
      r = this.db
        .query<Row, [string]>(
          "SELECT * FROM operator_welcome_log WHERE shopper_id = ? AND feedback_prompt_sent = 1",
        )
        .get(shopperId);
    }
    return Boolean(r && r.feedback_prompt_sent === 1);
  }

  recordFeedbackPromptSent(shopperId: string, connectionId: string, sentAt = nowIso()): void {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO operator_welcome_log (shopper_id, connection_id, welcome_sent, feedback_prompt_sent, feedback_prompt_sent_at, created_at, updated_at)
       VALUES (?, ?, 1, 1, ?, ?, ?)
       ON CONFLICT (shopper_id, connection_id) DO UPDATE SET
         feedback_prompt_sent = 1,
         feedback_prompt_sent_at = excluded.feedback_prompt_sent_at,
         updated_at = excluded.updated_at`,
      [shopperId, connectionId, sentAt, ts, ts],
    );
  }

  recordWelcomeSent(shopperId: string, connectionId: string, sentAt = nowIso()): void {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO operator_welcome_log (shopper_id, connection_id, welcome_sent, sent_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT (shopper_id, connection_id) DO UPDATE SET
         welcome_sent = 1,
         sent_at = excluded.sent_at,
         updated_at = excluded.updated_at`,
      [shopperId, connectionId, sentAt, ts, ts],
    );
  }

  markSuppressed(shopperId: string, connectionId: string): void {
    const ts = nowIso();
    this.db.run(
      `INSERT INTO operator_welcome_log (shopper_id, connection_id, welcome_sent, sent_at, created_at, updated_at)
       VALUES (?, ?, 1, NULL, ?, ?)
       ON CONFLICT (shopper_id, connection_id) DO UPDATE SET
         welcome_sent = 1,
         updated_at = excluded.updated_at`,
      [shopperId, connectionId, ts, ts],
    );
  }
}
