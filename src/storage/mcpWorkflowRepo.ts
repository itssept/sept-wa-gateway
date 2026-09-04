/**
 * Submit+poll correlation store. When an inbound message is submitted to
 * PromptQL, we persist the correlation so the eventual result routes back to the
 * originating chat from durable state (handoff outbound step 2: resolve the
 * originating chat from durable mapping data, not only transient request state).
 */

import type { Database } from "bun:sqlite";
import { nowIso, uuid } from "../util.ts";

export type WorkflowStatus = "submitted" | "done" | "failed";

export interface McpWorkflow {
  id: string;
  connectionId: string;
  chatJid: string;
  shopperId: string;
  inboundMessageId: string;
  remoteRef: string | null;
  status: WorkflowStatus;
  resultText: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  connection_id: string;
  chat_jid: string;
  shopper_id: string;
  inbound_message_id: string;
  remote_ref: string | null;
  status: string;
  result_text: string | null;
  created_at: string;
  updated_at: string;
}

function toWorkflow(r: Row): McpWorkflow {
  return {
    id: r.id,
    connectionId: r.connection_id,
    chatJid: r.chat_jid,
    shopperId: r.shopper_id,
    inboundMessageId: r.inbound_message_id,
    remoteRef: r.remote_ref,
    status: r.status as WorkflowStatus,
    resultText: r.result_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class McpWorkflowRepo {
  constructor(private readonly db: Database) {}

  create(input: {
    connectionId: string;
    chatJid: string;
    shopperId: string;
    inboundMessageId: string;
    remoteRef?: string | null;
  }): McpWorkflow {
    const id = uuid();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO mcp_workflow
         (id, connection_id, chat_jid, shopper_id, inbound_message_id,
          remote_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      [
        id,
        input.connectionId,
        input.chatJid,
        input.shopperId,
        input.inboundMessageId,
        input.remoteRef ?? null,
        ts,
        ts,
      ],
    );
    return this.getById(id)!;
  }

  getById(id: string): McpWorkflow | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM mcp_workflow WHERE id = ?")
      .get(id);
    return r ? toWorkflow(r) : null;
  }

  markDone(id: string, resultText: string): void {
    this.db.run(
      "UPDATE mcp_workflow SET status = 'done', result_text = ?, updated_at = ? WHERE id = ?",
      [resultText, nowIso(), id],
    );
  }

  markFailed(id: string): void {
    this.db.run("UPDATE mcp_workflow SET status = 'failed', updated_at = ? WHERE id = ?", [
      nowIso(),
      id,
    ]);
  }
}
