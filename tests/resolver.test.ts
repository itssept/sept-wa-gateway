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
  const { shopper } = ctx.shoppers.register("S", phone, "s-room");
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
  const { shopper } = ctx.shoppers.register("S", "+14155551212", "s-room");
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

// --- Auto-resolve by sender phone (no explicit mapping) ---

test("DM auto-resolves by sender phone when unmapped", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  // No mapping for JID_A; sender phone matches the shopper.
  const res = ctx.resolver.resolve(CONN, JID_A, "+14155551212");
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.shopper.id).toBe(s.id);
    expect(res.via).toBe("sender");
  }
});

test("group message auto-resolves by the participant's phone", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  const GROUP = "120363000000006913@g.us";
  // Group jid is unmapped; the individual sender is the registered shopper.
  const res = ctx.resolver.resolve(CONN, GROUP, "+14155551212");
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.shopper.id).toBe(s.id);
});

test("sender who is not a registered shopper is rejected", () => {
  const { ctx } = makeTestApp();
  seedShopper(ctx, "+14155551212");
  const res = ctx.resolver.resolve(CONN, JID_B, "+19999999999");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("unregistered_sender");
});

test("no mapping and no sender phone stays unmapped", () => {
  const { ctx } = makeTestApp();
  seedShopper(ctx, "+14155551212");
  const res = ctx.resolver.resolve(CONN, JID_A, null);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("unmapped");
});

test("explicit mapping overrides sender auto-resolution", () => {
  const { ctx } = makeTestApp();
  const mapped = seedShopper(ctx, "+14155551212");
  const sender = seedShopper(ctx, "+14155559999");
  // Chat is mapped to `mapped`, but the sender's phone is `sender`. Mapping wins.
  ctx.mappings.upsert(CONN, JID_A, mapped.id);
  const res = ctx.resolver.resolve(CONN, JID_A, "+14155559999");
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.shopper.id).toBe(mapped.id);
    expect(res.via).toBe("mapping");
  }
  // silence unused-var lint on `sender`
  expect(sender.id).not.toBe(mapped.id);
});

test("disabled shopper reached via sender is still rejected", () => {
  const { ctx } = makeTestApp();
  const s = seedShopper(ctx, "+14155551212");
  ctx.shoppers.setStatus(s.id, "disabled");
  const res = ctx.resolver.resolve(CONN, JID_A, "+14155551212");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("shopper_disabled");
});
