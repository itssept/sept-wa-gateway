import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openDatabase } from "../src/storage/db.ts";
import { MIGRATIONS } from "../src/storage/schema.ts";
import { GatewaySettingsRepo } from "../src/storage/gatewaySettingsRepo.ts";
import { CredentialStore } from "../src/storage/credentialStore.ts";
import { ShopperRepo } from "../src/storage/shopperRepo.ts";
import { nowIso } from "../src/util.ts";

const ENC = Buffer.alloc(32, 7);

test("gateway setup and both shopper roles survive restart, encrypted with the existing key", () => {
  const path = join(tmpdir(), `sept-settings-${crypto.randomUUID()}.sqlite`);
  try {
    const db = openDatabase(path);
    const settings = new GatewaySettingsRepo(db, ENC);
    const creds = new CredentialStore(db, ENC);
    const { shopper } = new ShopperRepo(db).register("R", "+14155551212", "public-shopper");
    settings.set("client-persist-secret", "public-common");
    creds.setActive(shopper.id, "shopper-persist-secret", { label: "shopper" });
    creds.setActive(shopper.id, "pa-persist-secret", { label: "pa" });
    for (const row of db.query<{ token_encrypted: Uint8Array }, []>(
      "SELECT token_encrypted FROM shopper_credential",
    ).all()) {
      const encrypted = Buffer.from(row.token_encrypted);
      expect(encrypted.includes(Buffer.from("shopper-persist-secret"))).toBe(false);
      expect(encrypted.includes(Buffer.from("pa-persist-secret"))).toBe(false);
    }
    db.close();

    const reopened = openDatabase(path);
    const restoredSettings = new GatewaySettingsRepo(reopened, ENC);
    const restoredCreds = new CredentialStore(reopened, ENC);
    expect(restoredSettings.getStatus()).toEqual({ setupComplete: true, commonRoomName: "public-common" });
    expect(restoredSettings.getClientToken()).toBe("client-persist-secret");
    expect(restoredCreds.getActiveToken(shopper.id, "shopper")).toBe("shopper-persist-secret");
    expect(restoredCreds.getActiveToken(shopper.id, "pa")).toBe("pa-persist-secret");
    expect(() => new GatewaySettingsRepo(reopened, Buffer.alloc(32, 8)).getClientToken()).toThrow();
    reopened.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

test("migration 6 preserves legacy shoppers without inventing a PA token and is idempotent", () => {
  const path = join(tmpdir(), `sept-migrate-settings-${crypto.randomUUID()}.sqlite`);
  try {
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE _gateway_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((m) => m.version < 6)) {
      old.run(migration.sql);
      old.run("INSERT INTO _gateway_migrations VALUES (?, ?, ?)", [migration.version, migration.name, nowIso()]);
    }
    const { shopper } = new ShopperRepo(old).register("Old", "+14155551212", "old-room");
    const oldCred = new CredentialStore(old, ENC).setActive(shopper.id, "legacy-shopper-token");
    old.close();

    for (let reopen = 0; reopen < 2; reopen++) {
      const db = openDatabase(path);
      const settings = new GatewaySettingsRepo(db, ENC);
      const creds = new CredentialStore(db, ENC);
      expect(new ShopperRepo(db).getById(shopper.id)).toEqual(shopper);
      expect(creds.getActiveInfo(shopper.id, "shopper")).toEqual(oldCred);
      expect(creds.getActiveToken(shopper.id, "shopper")).toBe("legacy-shopper-token");
      expect(creds.getActiveToken(shopper.id, "pa")).toBeNull();
      expect(settings.getStatus()).toEqual({ setupComplete: false, commonRoomName: null });
      expect(settings.getClientToken()).toBeNull();
      expect(db.query<{ n: number }, []>(
        "SELECT COUNT(1) AS n FROM _gateway_migrations WHERE version = 6",
      ).get()?.n).toBe(1);
      db.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

test("storage rejects invalid gateway setup input and validates persisted settings", () => {
  const db = openDatabase(":memory:");
  try {
    const settings = new GatewaySettingsRepo(db, ENC);
    expect(() => settings.set("", "room")).toThrow();
    expect(() => settings.set("valid-client-token", " ")).toThrow();
    expect(settings.getStatus()).toEqual({ setupComplete: false, commonRoomName: null });
    settings.set("valid-client-token", "public-room");
    expect(() => db.run(
      "INSERT INTO gateway_settings VALUES (2, X'00', 'other', 'now', 'now')",
    )).toThrow();
    db.run("UPDATE gateway_settings SET common_room_name = '' WHERE id = 1");
    expect(() => settings.getStatus()).toThrow();
  } finally {
    db.close();
  }
});

test("credential lookup and writes reject unknown roles instead of falling back to shopper", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new CredentialStore(db, ENC);
    const { shopper } = new ShopperRepo(db).register("R", "+14155551212", "room");
    store.setActive(shopper.id, "shopper-secret-token");
    // Simulate an untyped caller at the storage boundary.
    expect(() => store.getActiveToken(shopper.id, "client" as never)).toThrow();
    expect(() => store.revokeActive(shopper.id, "client" as never)).toThrow();
    expect(() => store.setActive(shopper.id, "other-secret-token", { label: "client" as never })).toThrow();
    expect(store.getActiveToken(shopper.id)).toBe("shopper-secret-token");
  } finally {
    db.close();
  }
});