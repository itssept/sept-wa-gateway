/**
 * Outbound idempotency tests: claim/dedup, in-flight rejection, claim-token
 * fencing (a lost claim can't overwrite the terminal state).
 */

import { test, expect } from "bun:test";
import { openDatabase } from "../src/storage/db.ts";
import { OutboundLog } from "../src/storage/outboundLog.ts";

const CONN = "c1";

test("second claim of a sent key dedups", () => {
  const db = openDatabase(":memory:");
  const log = new OutboundLog(db);
  const c1 = log.claim(CONN, "msg-1");
  expect(c1.status).toBe("claimed");
  if (c1.status !== "claimed") return;
  log.markSent(CONN, "msg-1", c1.token, { chatJid: "a@x", messageRef: "ref-1" });

  const c2 = log.claim(CONN, "msg-1");
  expect(c2.status).toBe("already_sent");
});

test("a fresh pending claim blocks a concurrent claim as in_flight", () => {
  const db = openDatabase(":memory:");
  const log = new OutboundLog(db);
  const c1 = log.claim(CONN, "msg-1");
  expect(c1.status).toBe("claimed");
  const c2 = log.claim(CONN, "msg-1");
  expect(c2.status).toBe("in_flight");
});

test("markSent from a superseded claim token is rejected", () => {
  const db = openDatabase(":memory:");
  const log = new OutboundLog(db);
  const c1 = log.claim(CONN, "msg-1");
  if (c1.status !== "claimed") throw new Error("expected claim");
  // A failed row can be reclaimed with a new token.
  log.markFailed(CONN, "msg-1", c1.token);
  const c2 = log.claim(CONN, "msg-1");
  if (c2.status !== "claimed") throw new Error("expected reclaim");

  // The OLD token must not be able to mark sent now.
  const okOld = log.markSent(CONN, "msg-1", c1.token, { chatJid: "a", messageRef: "r" });
  expect(okOld).toBe(false);
  // The NEW token can.
  const okNew = log.markSent(CONN, "msg-1", c2.token, { chatJid: "a", messageRef: "r" });
  expect(okNew).toBe(true);
});

test("keys are isolated per connection", () => {
  const db = openDatabase(":memory:");
  const log = new OutboundLog(db);
  const a = log.claim("connA", "shared-key");
  const b = log.claim("connB", "shared-key");
  expect(a.status).toBe("claimed");
  expect(b.status).toBe("claimed"); // different connection → independent
});
