/**
 * Per-shopper MCP service-account credential store. The raw token is encrypted
 * at rest and NEVER returned after creation — the rest of the app receives only
 * CredentialInfo (fingerprint + status), or, at the send boundary, the decrypted
 * token via `getActiveToken` which is used immediately and never logged.
 *
 * Rotation revokes the current active credential (for that shopper+label) and
 * inserts a new active one, so the partial-unique index invariant "one active
 * per (shopper,label)" always holds.
 */

import type { Database } from "bun:sqlite";
import type { CredentialInfo, CredentialStatus } from "../domain/types.ts";
import { encrypt, decryptToString, sha256Hex } from "../crypto.ts";
import { nowIso, uuid } from "../util.ts";

interface Row {
  id: string;
  shopper_id: string;
  label: string;
  service_account_id: string | null;
  token_encrypted: Uint8Array;
  token_fingerprint: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toInfo(r: Row): CredentialInfo {
  return {
    id: r.id,
    shopperId: r.shopper_id,
    label: r.label,
    serviceAccountId: r.service_account_id,
    tokenFingerprint: r.token_fingerprint,
    status: r.status as CredentialStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class CredentialStore {
  constructor(
    private readonly db: Database,
    private readonly encKey: Buffer,
  ) {}

  /**
   * Set (create or rotate) the active credential for a shopper+label. Any
   * existing active credential for that pair is revoked first, in one txn.
   * Returns the non-secret info of the new credential.
   */
  setActive(
    shopperId: string,
    token: string,
    opts: { label?: string; serviceAccountId?: string | null } = {},
  ): CredentialInfo {
    const label = opts.label ?? "shopper";
    const id = uuid();
    const ts = nowIso();
    const enc = encrypt(token, this.encKey);
    const fingerprint = sha256Hex(token);

    const tx = this.db.transaction(() => {
      this.db.run(
        `UPDATE shopper_credential SET status = 'revoked', updated_at = ?
         WHERE shopper_id = ? AND label = ? AND status = 'active'`,
        [ts, shopperId, label],
      );
      this.db.run(
        `INSERT INTO shopper_credential
           (id, shopper_id, label, service_account_id, token_encrypted,
            token_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, shopperId, label, opts.serviceAccountId ?? null, enc, fingerprint, ts, ts],
      );
    });
    tx();
    return this.getById(id)!;
  }

  /** Revoke the active credential for a shopper+label. Returns true if one was revoked. */
  revokeActive(shopperId: string, label = "shopper"): boolean {
    const info = this.getActiveInfo(shopperId, label);
    if (!info) return false;
    this.db.run(
      "UPDATE shopper_credential SET status = 'revoked', updated_at = ? WHERE id = ?",
      [nowIso(), info.id],
    );
    return true;
  }

  getById(id: string): CredentialInfo | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM shopper_credential WHERE id = ?")
      .get(id);
    return r ? toInfo(r) : null;
  }

  getActiveInfo(shopperId: string, label = "shopper"): CredentialInfo | null {
    const r = this.db
      .query<Row, [string, string]>(
        `SELECT * FROM shopper_credential
         WHERE shopper_id = ? AND label = ? AND status = 'active'`,
      )
      .get(shopperId, label);
    return r ? toInfo(r) : null;
  }

  listInfo(shopperId: string): CredentialInfo[] {
    return this.db
      .query<Row, [string]>(
        "SELECT * FROM shopper_credential WHERE shopper_id = ? ORDER BY created_at ASC",
      )
      .all(shopperId)
      .map(toInfo);
  }

  /**
   * Decrypt and return the active token for a shopper+label. Used ONLY at the
   * MCP send boundary. The caller must never log or persist the return value.
   * Returns null when there is no active credential.
   */
  getActiveToken(shopperId: string, label = "shopper"): string | null {
    const r = this.db
      .query<Row, [string, string]>(
        `SELECT * FROM shopper_credential
         WHERE shopper_id = ? AND label = ? AND status = 'active'`,
      )
      .get(shopperId, label);
    if (!r) return null;
    return decryptToString(Buffer.from(r.token_encrypted), this.encKey);
  }
}
