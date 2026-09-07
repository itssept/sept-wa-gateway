/**
 * Test helpers: build an in-memory context + a bound admin request maker.
 */

import { Database } from "bun:sqlite";
import { openDatabase } from "../src/storage/db.ts";
import { createContext, type AppContext } from "../src/context.ts";
import { makeHandler } from "../src/http/adminApi.ts";
import { createLogger } from "../src/logger.ts";
import type { Config } from "../src/config.ts";

export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
const TEST_ENC_KEY = Buffer.alloc(32, 7);

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiPort: 0,
    apiHost: "127.0.0.1",
    adminToken: TEST_ADMIN_TOKEN,
    dataEncryptionKey: TEST_ENC_KEY,
    dbPath: ":memory:",
    maxMediaBytes: 7 * 1024 * 1024,
    logLevel: "error",
    connectionId: "test-conn",
    deviceLabel: undefined,
    sendRatePerSec: 100,
    warmupDays: 0,
    maxPendingSendsPerConnection: 100,
    groupMetaTtlMs: 3_600_000,
    messageRetentionDays: 90,
    mcp: {
      endpoint: "https://example.test/mcp",
      authScheme: "pat",
      protocolVersion: "2025-03-26",
      timeoutMs: 5_000,
      maxRetries: 1,
      responseMaxMs: 5_000,
      ...overrides.mcp,
    },
    ...overrides,
  };
}

/** A minimal WhatsAppConnection stub for exercising the connection API without
 *  a real Baileys socket. Records link/unlink calls for assertions. */
export class FakeConnection {
  number = "";
  status: "pending" | "linked" | "logged_out" = "pending";
  linkedAtMs: number | null = null;
  pairingCode: string | undefined = undefined;
  linkCalls: Array<{ number: string; deviceLabel?: string }> = [];
  unlinkCalls = 0;

  async link(numberE164: string, deviceLabel?: string): Promise<void> {
    this.linkCalls.push({ number: numberE164, deviceLabel });
    this.number = numberE164;
    this.status = "pending";
    this.pairingCode = "ABCD-1234";
  }
  unlink(): void {
    this.unlinkCalls++;
    this.status = "logged_out";
    this.number = "";
    this.pairingCode = undefined;
  }
}

export function makeTestApp(
  config = testConfig(),
  connection?: FakeConnection,
): {
  ctx: AppContext;
  db: Database;
  handle: (req: Request) => Promise<Response>;
  connection?: FakeConnection;
  /** Captured log lines (parsed JSON), in emit order. */
  logs: Array<Record<string, unknown>>;
} {
  const db = openDatabase(":memory:");
  const logs: Array<Record<string, unknown>> = [];
  const log = createLogger({
    level: config.logLevel,
    sink: (line) => logs.push(JSON.parse(line)),
  });
  const ctx = createContext(config, db, log);
  // The handler only uses the WhatsAppConnection's public surface; the fake
  // matches it structurally.
  const handle = makeHandler({ ctx, connection: connection as never });
  return { ctx, db, handle, connection, logs };
}

/** Parse a Response body as an arbitrary JSON object (test-only convenience). */
export async function jsonBody(res: Response): Promise<any> {
  return (await res.json()) as any;
}

export function adminReq(
  handle: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string = TEST_ADMIN_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let bodyStr: string | undefined;
  if (body !== undefined) {
    bodyStr = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
  }
  return handle(
    new Request(`http://test${path}`, { method, headers, body: bodyStr }),
  );
}
