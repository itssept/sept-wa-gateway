/**
 * Shopper repository. Registration is idempotent on canonical phone number:
 * re-registering the same phone returns the existing shopper rather than
 * creating a duplicate (handoff: duplicate registration + idempotency).
 */

import type { Database } from "bun:sqlite";
import type { Shopper, ShopperStatus } from "../domain/types.ts";
import { nowIso, uuid } from "../util.ts";

interface Row {
  id: string;
  name: string;
  phone_e164: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toShopper(r: Row): Shopper {
  return {
    id: r.id,
    name: r.name,
    phoneE164: r.phone_e164,
    status: r.status as ShopperStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ShopperRepo {
  constructor(private readonly db: Database) {}

  /**
   * Create or return the existing shopper for a canonical phone. `phoneE164`
   * MUST already be canonicalized by the caller. Returns the shopper and whether
   * it was newly created (so the API can distinguish 201 from 200).
   */
  register(name: string, phoneE164: string): { shopper: Shopper; created: boolean } {
    const existing = this.getByPhone(phoneE164);
    if (existing) {
      // Idempotent: keep the original registration. Update the display name if
      // it changed, but never resurrect a disabled shopper implicitly.
      if (existing.name !== name) {
        this.db.run("UPDATE shopper SET name = ?, updated_at = ? WHERE id = ?", [
          name,
          nowIso(),
          existing.id,
        ]);
        return { shopper: { ...existing, name, updatedAt: nowIso() }, created: false };
      }
      return { shopper: existing, created: false };
    }
    const id = uuid();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO shopper (id, name, phone_e164, status, created_at, updated_at)
       VALUES (?, ?, ?, 'enabled', ?, ?)`,
      [id, name, phoneE164, ts, ts],
    );
    return { shopper: this.getById(id)!, created: true };
  }

  getById(id: string): Shopper | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM shopper WHERE id = ?")
      .get(id);
    return r ? toShopper(r) : null;
  }

  getByPhone(phoneE164: string): Shopper | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM shopper WHERE phone_e164 = ?")
      .get(phoneE164);
    return r ? toShopper(r) : null;
  }

  list(): Shopper[] {
    return this.db
      .query<Row, []>("SELECT * FROM shopper ORDER BY created_at ASC")
      .all()
      .map(toShopper);
  }

  setStatus(id: string, status: ShopperStatus): Shopper | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.db.run("UPDATE shopper SET status = ?, updated_at = ? WHERE id = ?", [
      status,
      nowIso(),
      id,
    ]);
    return this.getById(id);
  }
}
