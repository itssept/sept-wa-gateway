/**
 * Persistence across a "reboot": all gateway state lives in SQLite keyed by
 * connection_id, so reopening the same DB file recovers shoppers, credentials,
 * mappings, per-chat bot threads, and the linked-connection row (number +
 * status). Migrations are append-only, so a version bump preserves rows.
 */

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openDatabase } from "../src/storage/db.ts";
import { ShopperRepo } from "../src/storage/shopperRepo.ts";
import { CredentialStore } from "../src/storage/credentialStore.ts";
import { MappingRepo } from "../src/storage/mappingRepo.ts";
import { ChatBotRepo } from "../src/storage/chatBotRepo.ts";
import { nowIso } from "../src/util.ts";

const ENC = Buffer.alloc(32, 7);

/** A unique on-disk DB path (in-memory DBs can't be reopened as a new handle). */
function tmpDbPath(): string {
  // Vary by index-free unique-ish name without Date.now/Math.random.
  const p = join(tmpdir(), `sept-persist-${process.pid}-${globalThis.crypto.randomUUID()}.sqlite`);
  return p;
}

test("gateway state survives reopening the DB file (reboot)", () => {
  const path = tmpDbPath();
  try {
    // --- first boot: link + register everything ---
    {
      const db = openDatabase(path);
      // Simulate a completed link (what onConnectionUpdate writes on 'open').
      const ts = nowIso();
      db.run(
        `INSERT INTO whatsapp_connection
           (connection_id, number_e164, link_status, link_method, linked_at, created_at, updated_at)
         VALUES ('c1', '+14155551212', 'linked', 'pairing', ?, ?, ?)`,
        [ts, ts, ts],
      );
      const shoppers = new ShopperRepo(db);
      const creds = new CredentialStore(db, ENC);
      const mappings = new MappingRepo(db);
      const bots = new ChatBotRepo(db);

      const { shopper } = shoppers.register("Rakesh", "+14155551212", "rakesh-room");
      creds.setActive(shopper.id, "mcp-secret-token", { serviceAccountId: "sa-1" });
      mappings.upsert("c1", "14155551212@s.whatsapp.net", shopper.id);
      bots.upsert({
        connectionId: "c1",
        chatJid: "14155551212@s.whatsapp.net",
        shopperId: shopper.id,
        threadId: "thread-xyz",
        roomName: "sept-r",
      });
      db.close();
    }

    // --- reboot: reopen the SAME file, new handles ---
    {
      const db = openDatabase(path);
      const shoppers = new ShopperRepo(db);
      const creds = new CredentialStore(db, ENC);
      const mappings = new MappingRepo(db);
      const bots = new ChatBotRepo(db);

      // Connection row (number + linked status) recovered.
      const conn = db
        .query<{ number_e164: string; link_status: string; linked_at: string | null }, [string]>(
          "SELECT number_e164, link_status, linked_at FROM whatsapp_connection WHERE connection_id = ?",
        )
        .get("c1");
      expect(conn?.number_e164).toBe("+14155551212");
      expect(conn?.link_status).toBe("linked");
      expect(conn?.linked_at).toBeString();

      // Shopper + its still-decryptable MCP token recovered.
      const shopper = shoppers.getByPhone("+14155551212");
      expect(shopper).not.toBeNull();
      expect(shopper!.roomName).toBe("rakesh-room");
      expect(creds.getActiveToken(shopper!.id)).toBe("mcp-secret-token");

      // Mapping + per-chat bot thread recovered.
      const mapping = mappings.get("c1", "14155551212@s.whatsapp.net");
      expect(mapping?.shopperId).toBe(shopper!.id);
      const bot = bots.get("c1", "14155551212@s.whatsapp.net");
      expect(bot?.threadId).toBe("thread-xyz");

      db.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

test("re-running migrations on an existing DB is a no-op (version bump safe)", () => {
  const path = tmpDbPath();
  try {
    const db1 = openDatabase(path);
    const applied1 = db1
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _gateway_migrations")
      .get()!.n;
    db1.close();

    // Reopen (openDatabase re-runs the migration runner) — count unchanged, no throw.
    const db2 = openDatabase(path);
    const applied2 = db2
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _gateway_migrations")
      .get()!.n;
    expect(applied2).toBe(applied1);
    const messageColumns = db2
      .query<{ name: string }, []>("PRAGMA table_info(whatsapp_message_store)")
      .all()
      .map((column) => column.name);
    expect(messageColumns.some((name) => name.startsWith("media_"))).toBe(false);
    db2.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

test("migration 5 upgrades existing bots and persists pause and relay dedup across restart", async () => {
  const { Database } = await import("bun:sqlite");
  const { MIGRATIONS } = await import("../src/storage/schema.ts");
  const { OutboundLog } = await import("../src/storage/outboundLog.ts");
  const path = tmpDbPath();
  try {
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE _gateway_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((m) => m.version < 5)) {
      old.run(migration.sql);
      old.run("INSERT INTO _gateway_migrations VALUES (?, ?, ?)", [migration.version, migration.name, nowIso()]);
    }
    old.run("INSERT INTO chat_bot VALUES ('conn', '123@g.us', 's', 'bot', 'room', ?, ?)", [nowIso(), nowIso()]);
    old.close();
    const upgraded = openDatabase(path);
    const bots = new ChatBotRepo(upgraded);
    expect(bots.get("conn", "123@g.us")?.relayPausedAt).toBeNull();
    bots.pauseRelay("conn", "123@g.us");
    const log = new OutboundLog(upgraded);
    const claim = log.claim("conn", "relay");
    if (claim.status !== "claimed") throw new Error("expected claim");
    expect(log.markRelayed("conn", "relay", "wrong-token", "123@g.us")).toBe(false);
    expect(log.markRelayed("conn", "relay", claim.token, "123@g.us")).toBe(true);
    log.recordGatewayMessage("conn", "123@g.us", "sent-id");
    upgraded.close();
    const restarted = openDatabase(path);
    expect(new ChatBotRepo(restarted).get("conn", "123@g.us")?.threadId).toBe("bot");
    expect(new ChatBotRepo(restarted).get("conn", "123@g.us")?.relayPausedAt).toBeString();
    expect(new OutboundLog(restarted).claim("conn", "relay").status).toBe("already_sent");
    expect(new OutboundLog(restarted).isGatewayMessage("conn", "123@g.us", "sent-id")).toBe(true);
    restarted.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});
