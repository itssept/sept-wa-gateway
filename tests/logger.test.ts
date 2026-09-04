/**
 * Logger tests. The safety-critical behavior is the defensive redaction pass:
 * even if a caller forgets to mask, a phone number / jid / token / message body
 * must never reach the emitted line. These tests assert on the raw JSON output.
 */

import { test, expect } from "bun:test";
import { createLogger, type Logger, type LogFields } from "../src/logger.ts";

/** Build a logger that captures emitted lines (parsed) instead of writing them. */
function captureLogger(level: Parameters<typeof createLogger>[0]["level"] = "debug"): {
  log: Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({
    level,
    sink: (line) => lines.push(JSON.parse(line)),
    now: () => "2026-09-04T00:00:00.000Z",
  });
  return { log, lines };
}

test("emits one JSON object per line with level, time, msg", () => {
  const { log, lines } = captureLogger();
  log.info("hello", { shopperId: "s1" });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEqual({
    level: "info",
    time: "2026-09-04T00:00:00.000Z",
    msg: "hello",
    shopperId: "s1",
  });
});

test("level gating drops lines below the configured level", () => {
  const { log, lines } = captureLogger("warn");
  log.debug("nope");
  log.info("nope");
  log.warn("yes");
  log.error("yes");
  expect(lines.map((l) => l.msg)).toEqual(["yes", "yes"]);
});

test("redacts a raw phone number passed under a phone/number key", () => {
  const { log, lines } = captureLogger();
  log.info("x", { number: "+14155551212", senderPhoneE164: "+14155559999" });
  const line = JSON.stringify(lines[0]);
  expect(line).not.toContain("4155551212");
  expect(line).not.toContain("4155559999");
  expect(lines[0].number).toBe("***1212");
  expect(lines[0].senderPhoneE164).toBe("***9999");
});

test("redacts a raw jid passed under a *jid key", () => {
  const { log, lines } = captureLogger();
  log.info("x", { chatJid: "14155551212@s.whatsapp.net" });
  const line = JSON.stringify(lines[0]);
  expect(line).not.toContain("14155551212");
  expect(lines[0].chatJid).toBe("***1212@s.whatsapp.net");
});

test("redacts tokens/secrets/credentials", () => {
  const { log, lines } = captureLogger();
  log.info("x", { mcpToken: "super-secret-token-value", authorization: "pat abc123" });
  const line = JSON.stringify(lines[0]);
  expect(line).not.toContain("super-secret-token-value");
  expect(line).not.toContain("abc123");
});

test("drops raw message content entirely, keeping only length", () => {
  const { log, lines } = captureLogger();
  log.info("x", { text: "hello my card number is 4111 1111 1111 1111" });
  const line = JSON.stringify(lines[0]);
  expect(line).not.toContain("4111");
  expect(line).not.toContain("hello my card");
  expect(lines[0].text).toBeUndefined();
  expect(lines[0].textLength).toBe(43);
});

test("recurses into nested objects (e.g. audit detail)", () => {
  const { log, lines } = captureLogger();
  log.info("x", { detail: { chatJid: "14155551212@s.whatsapp.net", reason: "unmapped" } });
  const detail = lines[0].detail as Record<string, unknown>;
  expect(detail.chatJid).toBe("***1212@s.whatsapp.net");
  expect(detail.reason).toBe("unmapped");
  expect(JSON.stringify(lines[0])).not.toContain("14155551212");
});

test("serializes an Error under `err` to name + message (no stack/PII)", () => {
  const { log, lines } = captureLogger();
  log.error("boom", { err: new TypeError("bad thing") });
  expect(lines[0].err).toEqual({ name: "TypeError", message: "bad thing" });
});

test("child() binds context and redacts it once", () => {
  const { log, lines } = captureLogger();
  const child = log.child({ component: "inbound", chatJid: "14155551212@s.whatsapp.net" });
  child.info("ask", { shopperId: "s1" });
  expect(lines[0].component).toBe("inbound");
  expect(lines[0].chatJid).toBe("***1212@s.whatsapp.net");
  expect(lines[0].shopperId).toBe("s1");
});

test("undefined fields are omitted, not emitted as null", () => {
  const { log, lines } = captureLogger();
  const fields: LogFields = { a: undefined, b: 1 };
  log.info("x", fields);
  expect("a" in lines[0]).toBe(false);
  expect(lines[0].b).toBe(1);
});
