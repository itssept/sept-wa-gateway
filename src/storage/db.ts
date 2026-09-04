/**
 * SQLite open + migration runner. Uses bun:sqlite. Applied migration versions
 * are recorded in `_gateway_migrations`; unapplied ones run in order inside a
 * single transaction so a partial upgrade never leaves a half-applied schema.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";
import { nowIso } from "../util.ts";

export function openDatabase(dbPath: string): Database {
  // In-memory DBs (":memory:") have no directory to create.
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _gateway_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db
    .query<{ version: number }, []>("SELECT version FROM _gateway_migrations")
    .all();
  const applied = new Set(appliedRows.map((r) => r.version));

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return;

  const tx = db.transaction(() => {
    for (const m of pending) {
      db.run(m.sql);
      db.run(
        "INSERT INTO _gateway_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [m.version, m.name, nowIso()],
      );
    }
  });
  tx();
}
