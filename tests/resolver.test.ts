/**
 * Resolver tests: unknown/disabled/unmapped/no-credential rejection, and chat
 * mapping isolation (a jid maps to exactly one shopper).
 */

import { test, expect } from "bun:test";
import { makeTestApp } from "./helpers.ts";

const CONN = "test-conn";
const JID_A = "14155551212@s.whatsapp.net";
const JID_B = "14155559999@s.whatsapp.net";

function seedShopper(
  ctx: ReturnType<typeof makeTestApp>["ctx"],
  phone: string,
  token = "tok-12345678",
) {
  const { shopper } = ctx.shoppers.register("S", phone);
  ctx.credentials.setActive(shopper.id, token);
  return shopper;
}

test("unmapped chat is rejected", () => {
  const { ctx } = makeTestApp();
  const res = ctx.resolver.resolve(CONN, JID_A);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("unmapped");
});

test("mapped + enabled shopper with credential resolves", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  ctx.mappings.upsert(CONN, JID_A, s.id);
  const res = ctx.resolver.resolve(CONN, JID_A);
  expect(res.ok).toBe(true);
});

test("disabled shopper is rejected", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  ctx.mappings.upsert(CONN, JID_A, s.id);
  ctx.shoppers.setStatus(s.id, "disabled");
  const res = ctx.resolver.resolve(CONN, JID_A);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("shopper_disabled");
});

test("disabled mapping is rejected", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  ctx.mappings.upsert(CONN, JID_A, s.id);
  ctx.mappings.setStatus(CONN, JID_A, "disabled");
  const res = ctx.resolver.resolve(CONN, JID_A);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("mapping_disabled");
});

test("shopper without an active credential is rejected", () => {
  const { ctx } = makeTestApp();
  const { shopper } = ctx.shoppers.register("S", "+14155551212");
  ctx.mappings.upsert(CONN, JID_A, shopper.id);
  const res = ctx.resolver.resolve(CONN, JID_A);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("no_active_credential");
});

test("mapping isolation: each jid resolves to its own shopper", () => {
  const { ctx } = makeTestApp();
  const a = seedShopper(ctx, "+14155551212");
  const b = seedShopper(ctx, "+14155559999");
  ctx.mappings.upsert(CONN, JID_A, a.id);
  ctx.mappings.upsert(CONN, JID_B, b.id);
  const ra = ctx.resolver.resolve(CONN, JID_A);
  const rb = ctx.resolver.resolve(CONN, JID_B);
  expect(ra.ok && ra.shopper.id).toBe(a.id);
  expect(rb.ok && rb.shopper.id).toBe(b.id);
});
