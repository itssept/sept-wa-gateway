/**
 * Structured JSON logger for the gateway.
 *
 * Why this exists: the gateway is not wired to any observability stack, and it
 * moves WhatsApp traffic — so every log line risks leaking PII (phone numbers,
 * jids, message text) or a secret. This logger gives us one place that:
 *
 *   1. Emits ONE JSON object per line (level, time, msg, component, fields) so
 *      cloud log aggregation can parse it without regexes.
 *   2. Carries bound context (component, corrId, connectionId, shopperId) via
 *      `child()`, so we stop hand-formatting `[tag] corr=...` strings.
 *   3. Runs a DEFENSIVE redaction pass over known-sensitive field keys as a
 *      safety net. Callers are still expected to mask with maskJid/maskNumber/
 *      maskSecret (see util.ts) — redaction is the belt-and-suspenders backstop
 *      for a missed call site, not the primary defense.
 *
 * Rule: never log a raw phone number, jid, token, or message BODY. Message text
 * is logged only as `textLength`, never the text itself.
 */

import { maskJid, maskNumber, maskSecret } from "./util.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Structured fields attached to a log line. Values must already be masked. */
export type LogFields = Record<string, unknown>;

/**
 * Field-name substrings that must never carry a raw value. If a caller passes
 * one of these keys, the logger re-masks it defensively based on the key's
 * intent. This is a backstop — prefer masking at the call site.
 */
const SENSITIVE_KEY_PATTERNS: Array<{
  test: (key: string) => boolean;
  mask: (value: unknown) => string;
}> = [
  // Anything that looks like a secret/token/credential/key/pat/password.
  {
    test: (k) => /(token|secret|credential|password|apikey|api_key|\bpat\b|authorization|auth)/i.test(k),
    mask: (v) => maskSecret(v == null ? null : String(v)),
  },
  // jids (chat/sender/remote/participant) — mask to last 4 + domain.
  {
    test: (k) => /jid/i.test(k),
    mask: (v) => maskJid(v == null ? null : String(v)),
  },
  // phone / number / e164 / msisdn — mask to last 4 digits.
  {
    test: (k) => /(phone|e164|msisdn|number|\bnumber\b)/i.test(k),
    mask: (v) => maskNumber(v == null ? null : String(v)),
  },
];

/**
 * Field keys whose VALUE is message content and must be dropped entirely. We
 * never log a message body; only its length is allowed (as `textLength`).
 */
const FORBIDDEN_CONTENT_KEYS = /^(text|body|message|caption|query|answer|content)$/i;

function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    // Drop raw message content outright — no masked form is safe to emit.
    if (FORBIDDEN_CONTENT_KEYS.test(key)) {
      out[`${key}Length`] =
        typeof value === "string" ? value.length : undefined;
      continue;
    }

    const rule = SENSITIVE_KEY_PATTERNS.find((r) => r.test(key));
    if (rule) {
      out[key] = rule.mask(value);
      continue;
    }

    // Recurse into nested plain objects (e.g. audit `detail`).
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Error)) {
      out[key] = redactFields(value as LogFields);
      continue;
    }

    out[key] = value;
  }
  return out;
}

/** Serialize an Error to a safe, structured shape (message + name, no PII expected). */
function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a child logger with additional bound context (merged, redacted). */
  child(bound: LogFields): Logger;
}

interface LoggerConfig {
  level: LogLevel;
  /** Injected for tests; defaults to console.error (stderr) for all levels. */
  sink?: (line: string) => void;
  /** Injected for tests; defaults to new Date().toISOString(). */
  now?: () => string;
}

class JsonLogger implements Logger {
  private readonly minLevel: number;
  private readonly sink: (line: string) => void;
  private readonly now: () => string;

  constructor(
    private readonly bound: LogFields,
    cfg: LoggerConfig,
  ) {
    this.minLevel = LEVEL_ORDER[cfg.level];
    // stderr keeps logs off stdout, where the pairing code / API responses go.
    this.sink = cfg.sink ?? ((line) => console.error(line));
    this.now = cfg.now ?? (() => new Date().toISOString());
    this.cfg = cfg;
  }

  private cfg: LoggerConfig;

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const raw: LogFields = { ...this.bound, ...(fields ?? {}) };
    // `err` is a conventional field for an Error. Pull it OUT before redaction
    // so its `message` isn't swallowed by the forbidden-content-key rule, then
    // serialize it to a safe {name, message} shape and re-attach.
    const err = raw.err;
    delete raw.err;
    const safe = redactFields(raw);
    if (err !== undefined) safe.err = serializeError(err);
    const line = JSON.stringify({
      level,
      time: this.now(),
      msg,
      ...safe,
    });
    this.sink(line);
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }

  child(bound: LogFields): Logger {
    // Bound context is redacted once here so children never re-leak it.
    return new JsonLogger({ ...this.bound, ...redactFields(bound) }, this.cfg);
  }
}

/** Build the root logger. Call once at boot; derive per-component via child(). */
export function createLogger(cfg: LoggerConfig): Logger {
  return new JsonLogger({}, cfg);
}

/**
 * A shared no-config logger for modules that log before/without the app context
 * (e.g. the fatal handler). Level comes from LOG_LEVEL, defaulting to "info".
 * Real components should use the context logger (ctx.log) instead.
 */
export const rootLogger: Logger = createLogger({
  level: (process.env.LOG_LEVEL as LogLevel) || "info",
});
