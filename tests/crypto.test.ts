/**
 * Crypto + config validation tests.
 */

import { test, expect } from "bun:test";
import { encrypt, decryptToString, constantTimeEqual, sha256Hex } from "../src/crypto.ts";
import { loadConfig, resetConfigForTests } from "../src/config.ts";

const KEY = Buffer.alloc(32, 9);

test("encrypt/decrypt round-trips", () => {
  const ct = encrypt("hello secret", KEY);
  expect(decryptToString(ct, KEY)).toBe("hello secret");
});

test("decrypt with a wrong key fails (GCM auth)", () => {
  const ct = encrypt("hello", KEY);
  const wrong = Buffer.alloc(32, 1);
  expect(() => decryptToString(ct, wrong)).toThrow();
});

test("constantTimeEqual matches only identical strings", () => {
  expect(constantTimeEqual("abc", "abc")).toBe(true);
  expect(constantTimeEqual("abc", "abd")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
});

test("sha256Hex is stable and 64 hex chars", () => {
  const h = sha256Hex("token");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(sha256Hex("token")).toBe(h);
});

test("config rejects a short admin token", () => {
  resetConfigForTests();
  expect(() =>
    loadConfig({
      GATEWAY_ADMIN_TOKEN: "short",
      DATA_ENCRYPTION_KEY: "0".repeat(64),
    } as NodeJS.ProcessEnv),
  ).toThrow(/GATEWAY_ADMIN_TOKEN/);
});

test("config rejects a bad encryption key length", () => {
  resetConfigForTests();
  expect(() =>
    loadConfig({
      GATEWAY_ADMIN_TOKEN: "0123456789abcdef0123",
      DATA_ENCRYPTION_KEY: "deadbeef",
    } as NodeJS.ProcessEnv),
  ).toThrow(/DATA_ENCRYPTION_KEY/);
});

test("config composes the MCP endpoint from project url + path", () => {
  resetConfigForTests();
  const cfg = loadConfig({
    GATEWAY_ADMIN_TOKEN: "0123456789abcdef0123",
    DATA_ENCRYPTION_KEY: "0".repeat(64),
    PROMPTQL_PROJECT_URL: "https://proj.example.com/",
    PROMPTQL_MCP_PATH: "/mcp",
  } as NodeJS.ProcessEnv);
  expect(cfg.mcp.endpoint).toBe("https://proj.example.com/mcp");
  resetConfigForTests();
});

test("transient media limit defaults to and is capped at 7 MiB", () => {
  resetConfigForTests();
  const config = loadConfig({
    GATEWAY_ADMIN_TOKEN: "0123456789abcdef0123",
    DATA_ENCRYPTION_KEY: "0".repeat(64),
  } as NodeJS.ProcessEnv);
  expect(config.maxMediaBytes).toBe(7 * 1024 * 1024);

  resetConfigForTests();
  expect(() =>
    loadConfig({
      GATEWAY_ADMIN_TOKEN: "0123456789abcdef0123",
      DATA_ENCRYPTION_KEY: "0".repeat(64),
      WHATSAPP_MAX_MEDIA_BYTES: String(7 * 1024 * 1024 + 1),
    } as NodeJS.ProcessEnv),
  ).toThrow(/must not exceed 7 MiB/);
  resetConfigForTests();
});
