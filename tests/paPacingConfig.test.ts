import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadConfig, resetConfigForTests } from "../src/config.ts";

beforeEach(resetConfigForTests);
afterEach(resetConfigForTests);
const env = {
  GATEWAY_ADMIN_TOKEN: "test-admin-token-0123456789",
  DATA_ENCRYPTION_KEY: "00".repeat(32),
};

test("PA reply delay defaults to 2-5 seconds", () => {
  const config = loadConfig(env);
  expect(config.paReplyDelayMinMs).toBe(2_000);
  expect(config.paReplyDelayMaxMs).toBe(5_000);
});

test("PA delay accepts configured bounds, including equal bounds and zero", () => {
  for (const [min, max] of [[100, 900], [500, 500], [0, 0]]) {
    resetConfigForTests();
    const config = loadConfig({
      ...env,
      WHATSAPP_PA_REPLY_DELAY_MIN_MS: String(min),
      WHATSAPP_PA_REPLY_DELAY_MAX_MS: String(max),
    });
    expect([config.paReplyDelayMinMs, config.paReplyDelayMaxMs]).toEqual([min, max]);
  }
});

test("PA delay rejects reversed bounds", () => {
  expect(() => loadConfig({
    ...env,
    WHATSAPP_PA_REPLY_DELAY_MIN_MS: "5001",
  })).toThrow("WHATSAPP_PA_REPLY_DELAY_MAX_MS");
});

for (const field of ["WHATSAPP_PA_REPLY_DELAY_MIN_MS", "WHATSAPP_PA_REPLY_DELAY_MAX_MS"]) {
  test(`${field} rejects negative, fractional, nonnumeric and overflowing values`, () => {
    for (const value of ["-1", "1.5", "abc", "Infinity", "2147483648"]) {
      resetConfigForTests();
      expect(() => loadConfig({ ...env, [field]: value })).toThrow(field);
    }
  });
}
