/**
 * Management API boundary tests: auth, validation, secret non-disclosure,
 * rotation/revocation, duplicate registration idempotency, mapping upsert.
 */

import { test, expect } from "bun:test";
import { makeTestApp, adminReq, jsonBody, testConfig, TEST_ADMIN_TOKEN } from "./helpers.ts";

test("health is unauthenticated", async () => {
  const { handle } = makeTestApp();
  const res = await handle(new Request("http://test/health"));
  expect(res.status).toBe(200);
});

test("emits one access log line per request (method, resource, status, latency)", async () => {
  const { handle, logs } = makeTestApp(testConfig({ logLevel: "info" }));

  await handle(new Request("http://test/health"));
  const ok = await adminReq(handle, "GET", "/api/v1/shoppers");
  expect(ok.status).toBe(200);
  const unauthed = await adminReq(handle, "GET", "/api/v1/shoppers", undefined, "");
  expect(unauthed.status).toBe(401);

  const access = logs.filter((l) => l.msg === "request");
  expect(access).toHaveLength(3);

  // Health: unauthenticated, resource is "health", 200.
  expect(access[0]).toMatchObject({ method: "GET", resource: "health", status: 200 });
  // Authorized list: resource "shoppers", 200.
  expect(access[1]).toMatchObject({ method: "GET", resource: "shoppers", status: 200 });
  // Rejected auth still logs an access line with the 401 status.
  expect(access[2]).toMatchObject({ method: "GET", resource: "shoppers", status: 401 });

  // Latency is a rounded, non-negative number.
  for (const line of access) {
    expect(typeof line.durationMs).toBe("number");
    expect(line.durationMs as number).toBeGreaterThanOrEqual(0);
  }
});

test("access log never carries a raw chatJid from the path", async () => {
  const { handle, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  // A mapping status route embeds the chatJid in the path; only the resource
  // ("mappings") should appear in the access line, never the jid.
  await adminReq(handle, "POST", "/api/v1/mappings/14155551212@s.whatsapp.net/status", {
    enabled: false,
  });
  const access = logs.filter((l) => l.msg === "request");
  expect(access).toHaveLength(1);
  expect(access[0]).toMatchObject({ method: "POST", resource: "mappings" });
  expect(JSON.stringify(access[0])).not.toContain("14155551212");
});

test("management endpoints require the admin token", async () => {
  const { handle } = makeTestApp();
  const noAuth = await adminReq(handle, "GET", "/api/v1/shoppers", undefined, "");
  expect(noAuth.status).toBe(401);
  const wrong = await adminReq(handle, "GET", "/api/v1/shoppers", undefined, "wrong-token");
  expect(wrong.status).toBe(401);
  const ok = await adminReq(handle, "GET", "/api/v1/shoppers");
  expect(ok.status).toBe(200);
});

test("malformed and invalid payloads are rejected", async () => {
  const { handle } = makeTestApp();
  // Not JSON.
  const bad = await handle(
    new Request("http://test/api/v1/shoppers", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  expect(bad.status).toBe(400);

  // Missing fields → 422.
  const invalid = await adminReq(handle, "POST", "/api/v1/shoppers", { name: "x" });
  expect(invalid.status).toBe(422);

  // Bad phone → 422.
  const badPhone = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "x",
    phone: "abc",
    mcpToken: "12345678",
  });
  expect(badPhone.status).toBe(422);
});

test("shopper creation never returns the raw token, only a fingerprint", async () => {
  const { handle } = makeTestApp();
  const res = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "+1 (415) 555-1212",
    mcpToken: "super-secret-mcp-token",
  });
  expect(res.status).toBe(201);
  const body = await jsonBody(res);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("super-secret-mcp-token");
  expect(body.credential.tokenFingerprint).toBeString();
  // Phone canonicalized.
  expect(body.shopper.phoneE164).toBe("+14155551212");
});

test("duplicate registration is idempotent (same phone → 200, same id)", async () => {
  const { handle } = makeTestApp();
  const first = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "+14155551212",
    mcpToken: "token-a-12345678",
  });
  expect(first.status).toBe(201);
  const firstBody = await jsonBody(first);

  const second = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "14155551212", // equivalent form
    mcpToken: "token-b-12345678",
  });
  expect(second.status).toBe(200);
  const secondBody = await jsonBody(second);
  expect(secondBody.shopper.id).toBe(firstBody.shopper.id);
});

test("credential rotation revokes the old and returns a new active credential", async () => {
  const { ctx, handle } = makeTestApp();
  const created = await jsonBody(
    await adminReq(handle, "POST", "/api/v1/shoppers", {
      name: "R",
      phone: "+14155551212",
      mcpToken: "old-token-12345678",
    }),
  );
  const id = created.shopper.id;
  const firstFp = created.credential.tokenFingerprint;

  const rotated = await adminReq(
    handle,
    "POST",
    `/api/v1/shoppers/${id}/credential/rotate`,
    { mcpToken: "new-token-12345678" },
  );
  expect(rotated.status).toBe(200);
  const rotatedBody = await jsonBody(rotated);
  expect(rotatedBody.credential.tokenFingerprint).not.toBe(firstFp);

  // Exactly one active credential, and the active token is the new one.
  const active = ctx.credentials.getActiveToken(id);
  expect(active).toBe("new-token-12345678");
  const infos = ctx.credentials.listInfo(id);
  expect(infos.filter((c) => c.status === "active").length).toBe(1);
});

test("credential revoke removes the active token", async () => {
  const { ctx, handle } = makeTestApp();
  const created = await jsonBody(
    await adminReq(handle, "POST", "/api/v1/shoppers", {
      name: "R",
      phone: "+14155551212",
      mcpToken: "tok-12345678",
    }),
  );
  const id = created.shopper.id;
  const res = await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/revoke`);
  expect(res.status).toBe(200);
  expect(ctx.credentials.getActiveToken(id)).toBeNull();
});

test("mapping upsert requires an existing shopper", async () => {
  const { handle } = makeTestApp();
  const bad = await adminReq(handle, "POST", "/api/v1/mappings", {
    chatJid: "14155551212@s.whatsapp.net",
    shopperId: "does-not-exist",
  });
  expect(bad.status).toBe(422);
});
