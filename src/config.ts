/**
 * Environment parsing & validation. All configuration is read once at boot into
 * an immutable Config object. Fatal misconfiguration (missing secret, bad key
 * length, malformed URL) fails fast before we open a socket or an MCP session.
 *
 * Validation is done with Zod so the process/env boundary is checked the same
 * way as the HTTP boundary. Nothing here reads a per-shopper MCP token — those
 * live encrypted in the DB, never in env.
 */

import { z } from "zod";

/** A 32-byte key given as 64 hex chars or base64. Anything else is fatal. */
const EncryptionKey = z.string().transform((raw, ctx) => {
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) buf = b;
    } catch {
      /* fall through */
    }
  }
  if (!buf || buf.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64).",
    });
    return z.NEVER;
  }
  return buf;
});

const EnvSchema = z.object({
  // HTTP API
  GATEWAY_API_PORT: z.coerce.number().int().positive().default(8790),
  // Bind all interfaces by default so the API is reachable inside a container /
  // behind an ingress. Set to 127.0.0.1 for a loopback-only local run.
  GATEWAY_API_HOST: z.string().default("0.0.0.0"),

  // Admin auth (management API) — separate from any PromptQL credential.
  GATEWAY_ADMIN_TOKEN: z.string().min(16, "GATEWAY_ADMIN_TOKEN too short (>=16 chars)"),

  // Encryption at rest.
  DATA_ENCRYPTION_KEY: EncryptionKey,

  // Storage. Media is transient and is never written to disk/object storage.
  GATEWAY_DB_PATH: z.string().default("./data/sept-wa-gateway.sqlite"),
  WHATSAPP_MAX_MEDIA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(
      7 * 1024 * 1024,
      "WHATSAPP_MAX_MEDIA_BYTES must not exceed 7 MiB (PromptQL MCP request limit)",
    )
    .default(7 * 1024 * 1024),

  // Structured logging. JSON lines to stderr; level gates verbosity.
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // WhatsApp connection. One connection per process for now; the schema is
  // connection_id-keyed so multi-number is an additive change later. The NUMBER
  // is not configured here — it is set at runtime via POST /api/v1/connection/link
  // and persisted in whatsapp_connection (survives reboots).
  WHATSAPP_CONNECTION_ID: z.string().min(1).default("sept-gateway-1"),
  WHATSAPP_DEVICE_LABEL: z.string().optional(),

  // Anti-ban.
  WHATSAPP_SEND_RATE_PER_SEC: z.coerce.number().positive().default(1),
  WHATSAPP_WARMUP_DAYS: z.coerce.number().nonnegative().default(3),
  // Extra pause before typing for opt-in PA replies to clients. Keep within
  // setTimeout's range so an oversized value cannot wrap into an immediate send.
  WHATSAPP_PA_REPLY_DELAY_MIN_MS: z.coerce.number().int().nonnegative().max(2_147_483_647).default(2_000),
  WHATSAPP_PA_REPLY_DELAY_MAX_MS: z.coerce.number().int().nonnegative().max(2_147_483_647).default(5_000),
  WHATSAPP_MAX_PENDING_SENDS_PER_CONNECTION: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  WHATSAPP_GROUP_META_TTL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),

  // Capture history shared after the linked account joins a group.
  WHATSAPP_CAPTURE_GROUP_HISTORY: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),

  // Relay chats with no owning shopper (unregistered DM sender, unqualified
  // group) to PromptQL as the Client SA in the common room. Disabled by
  // default: such chats are dropped (audited), never relayed, until an enabled
  // registered shopper qualifies them.
  RELAY_UNREGISTERED_CHATS: z.enum(["true", "false"]).default("false")
    .transform((value) => value === "true"),

  WHATSAPP_HISTORY_JOIN_WAIT_MS: z.coerce.number().int().nonnegative().max(60_000).default(5_000),

  // Retention.
  WHATSAPP_MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // PromptQL MCP — the full endpoint URL (scheme + host + path + query). The
  // project name is a `project-name` query param inside this URL. Empty until
  // configured (MCP disabled). Auth scheme is separately configurable.
  PROMPTQL_MCP_URL: z.string().url().or(z.literal("")).default(""),
  PROMPTQL_PROJECT_NAME: z.string().min(3).optional(),
  PROMPTQL_MCP_AUTH_SCHEME: z.string().default("pat"),
  PROMPTQL_MCP_PROTOCOL_VERSION: z.string().default("2025-03-26"),
  PROMPTQL_MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PROMPTQL_MCP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // Overall ceiling for the blocking response wait (get_latest_promptql_thread_
  // response long-polls internally; we re-call it on `analyzing` until this).
  PROMPTQL_RESPONSE_MAX_MS: z.coerce.number().int().positive().default(180_000),

  // Per-artifact ceiling for a PromptQL artifact relayed back as a WhatsApp
  // document. WhatsApp's own document cap is ~100 MiB, but we keep this small so
  // a single oversized artifact can't dominate a chat or memory. An artifact
  // above this is skipped (audited), not truncated. Applies to the decoded
  // bytes, not the base64 wire size.
  PROMPTQL_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024, "PROMPTQL_MAX_ARTIFACT_BYTES must not exceed 16 MiB")
    .default(16 * 1024 * 1024),
}).refine((e) => e.WHATSAPP_PA_REPLY_DELAY_MIN_MS <= e.WHATSAPP_PA_REPLY_DELAY_MAX_MS, {
  path: ["WHATSAPP_PA_REPLY_DELAY_MAX_MS"],
  message: "must be greater than or equal to WHATSAPP_PA_REPLY_DELAY_MIN_MS",
});

export interface Config {
  apiPort: number;
  apiHost: string;
  adminToken: string;
  dataEncryptionKey: Buffer;
  dbPath: string;
  maxMediaBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";

  connectionId: string;
  deviceLabel: string | undefined;

  sendRatePerSec: number;
  warmupDays: number;
  paReplyDelayMinMs: number;
  paReplyDelayMaxMs: number;
  maxPendingSendsPerConnection: number;
  groupMetaTtlMs: number;
  messageRetentionDays: number;
  captureGroupHistory: boolean;
  historyJoinWaitMs: number;
  /** Relay ownerless (unregistered/unqualified) chats to the common room. */
  relayUnregisteredChats: boolean;

  mcp: {
    /** Full MCP endpoint URL (scheme + host + path + query). Empty until configured. */
    endpoint: string;
    projectName?: string;
    authScheme: string;
    protocolVersion: string;
    timeoutMs: number;
    maxRetries: number;
    responseMaxMs: number;
    /** Per-artifact byte ceiling for artifacts relayed to WhatsApp as documents. */
    maxArtifactBytes: number;
  };
}

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid gateway configuration:\n${issues}`);
  }
  const e = parsed.data;

  cached = {
    apiPort: e.GATEWAY_API_PORT,
    apiHost: e.GATEWAY_API_HOST,
    adminToken: e.GATEWAY_ADMIN_TOKEN,
    dataEncryptionKey: e.DATA_ENCRYPTION_KEY,
    dbPath: e.GATEWAY_DB_PATH,
    maxMediaBytes: e.WHATSAPP_MAX_MEDIA_BYTES,
    logLevel: e.LOG_LEVEL,

    connectionId: e.WHATSAPP_CONNECTION_ID,
    deviceLabel: e.WHATSAPP_DEVICE_LABEL || undefined,

    sendRatePerSec: e.WHATSAPP_SEND_RATE_PER_SEC,
    warmupDays: e.WHATSAPP_WARMUP_DAYS,
    paReplyDelayMinMs: e.WHATSAPP_PA_REPLY_DELAY_MIN_MS,
    paReplyDelayMaxMs: e.WHATSAPP_PA_REPLY_DELAY_MAX_MS,
    maxPendingSendsPerConnection: e.WHATSAPP_MAX_PENDING_SENDS_PER_CONNECTION,
    groupMetaTtlMs: e.WHATSAPP_GROUP_META_TTL_MS,
    messageRetentionDays: e.WHATSAPP_MESSAGE_RETENTION_DAYS,
    captureGroupHistory: e.WHATSAPP_CAPTURE_GROUP_HISTORY,
    historyJoinWaitMs: e.WHATSAPP_HISTORY_JOIN_WAIT_MS,
    relayUnregisteredChats: e.RELAY_UNREGISTERED_CHATS,

    mcp: {
      endpoint: e.PROMPTQL_MCP_URL,
      projectName: e.PROMPTQL_PROJECT_NAME,
      authScheme: e.PROMPTQL_MCP_AUTH_SCHEME,
      protocolVersion: e.PROMPTQL_MCP_PROTOCOL_VERSION,
      timeoutMs: e.PROMPTQL_MCP_TIMEOUT_MS,
      maxRetries: e.PROMPTQL_MCP_MAX_RETRIES,
      responseMaxMs: e.PROMPTQL_RESPONSE_MAX_MS,
      maxArtifactBytes: e.PROMPTQL_MAX_ARTIFACT_BYTES,
    },
  };
  return cached;
}

/** Test helper: drop the memoized config so a fresh env can be parsed. */
export function resetConfigForTests(): void {
  cached = null;
}
