/**
 * Management API boundary tests: auth, validation, secret non-disclosure,
 * rotation/revocation, duplicate registration idempotency, mapping upsert.
 */

import { test, expect, spyOn } from "bun:test";
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

test("access log never carries a raw path segment (only the resource)", async () => {
  const { handle, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  // A shopper sub-route embeds an id in the path; only the resource
  // ("shoppers") should appear in the access line, never the raw segment.
  await adminReq(handle, "POST", "/api/v1/shoppers/14155551212@s.whatsapp.net/status", {
    status: "disabled",
  });
  const access = logs.filter((l) => l.msg === "request");
  expect(access).toHaveLength(1);
  expect(access[0]).toMatchObject({ method: "POST", resource: "shoppers" });
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
  await setupGateway(handle);
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
    roomName: "room-x",
    paMcpToken: "pa-secret-12345678",
    mcpToken: "12345678",
  });
  expect(badPhone.status).toBe(422);

  // Missing mandatory roomName → 422.
  const noRoom = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "x",
    phone: "+14155551212",
    paMcpToken: "pa-secret-12345678",
    mcpToken: "12345678",
  });
  expect(noRoom.status).toBe(422);
});

test("shopper creation never returns the raw token, only a fingerprint", async () => {
  const { handle } = makeTestApp();
  await setupGateway(handle);
  const res = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "+1 (415) 555-1212",
    roomName: "rakesh-room",
    paMcpToken: "pa-secret-12345678",
    mcpToken: "super-secret-mcp-token",
  });
  expect(res.status).toBe(201);
  const body = await jsonBody(res);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("super-secret-mcp-token");
  expect(serialized).not.toContain("pa-secret-12345678");
  expect(body.paCredential.label).toBe("pa");
  expect(body.paCredential.tokenFingerprint).toBeString();
  expect(body.credential.tokenFingerprint).toBeString();
  // Phone canonicalized.
  expect(body.shopper.phoneE164).toBe("+14155551212");
  // Caller-owned room stored verbatim.
  expect(body.shopper.roomName).toBe("rakesh-room");
});

test("duplicate registration is idempotent (same phone → 200, same id)", async () => {
  const { handle } = makeTestApp();
  await setupGateway(handle);
  const first = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "+14155551212",
    roomName: "rakesh-room",
    paMcpToken: "pa-secret-12345678",
    mcpToken: "token-a-12345678",
  });
  expect(first.status).toBe(201);
  const firstBody = await jsonBody(first);

  const second = await adminReq(handle, "POST", "/api/v1/shoppers", {
    name: "Rakesh",
    phone: "14155551212", // equivalent form
    roomName: "rakesh-room",
    paMcpToken: "pa-secret-12345678",
    mcpToken: "token-b-12345678",
  });
  expect(second.status).toBe(200);
  const secondBody = await jsonBody(second);
  expect(secondBody.shopper.id).toBe(firstBody.shopper.id);
});

test("credential rotation revokes the old and returns a new active credential", async () => {
  const { ctx, handle } = makeTestApp();
  await setupGateway(handle);
  const created = await jsonBody(
    await adminReq(handle, "POST", "/api/v1/shoppers", {
      name: "R",
      phone: "+14155551212",
      roomName: "r-room",
      paMcpToken: "pa-secret-12345678",
      mcpToken: "old-token-12345678",
    }),
  );
  const id = created.shopper.id;
  const firstFp = created.credential.tokenFingerprint;

  const rotated = await adminReq(
    handle,
    "POST",
    `/api/v1/shoppers/${id}/credential/rotate`,
    { role: "shopper", mcpToken: "new-token-12345678" },
  );
  expect(rotated.status).toBe(200);
  const rotatedBody = await jsonBody(rotated);
  expect(rotatedBody.credential.tokenFingerprint).not.toBe(firstFp);

  // Exactly one active credential, and the active token is the new one.
  const active = ctx.credentials.getActiveToken(id);
  expect(active).toBe("new-token-12345678");
  const infos = ctx.credentials.listInfo(id);
  expect(infos.filter((c) => c.status === "active" && c.label === "shopper").length).toBe(1);
});

test("credential revoke removes the active token", async () => {
  const { ctx, handle } = makeTestApp();
  await setupGateway(handle);
  const created = await jsonBody(
    await adminReq(handle, "POST", "/api/v1/shoppers", {
      name: "R",
      phone: "+14155551212",
      roomName: "r-room",
      paMcpToken: "pa-secret-12345678",
      mcpToken: "tok-12345678",
    }),
  );
  const id = created.shopper.id;
  const res = await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/revoke`, { role: "shopper" });
  expect(res.status).toBe(200);
  expect(ctx.credentials.getActiveToken(id)).toBeNull();
});

test("mappings are internal: the mappings API is not exposed", async () => {
  const { handle } = makeTestApp();
  // Mappings are an internal routing mechanism; there is no public endpoint.
  const post = await adminReq(handle, "POST", "/api/v1/mappings", {
    chatJid: "14155551212@s.whatsapp.net",
    shopperId: "whatever",
  });
  expect(post.status).toBe(404);
  const get = await adminReq(handle, "GET", "/api/v1/mappings");
  expect(get.status).toBe(404);
});

const registration = {
  name: "Rakesh",
  phone: "+14155551212",
  roomName: "shopper-room",
  mcpToken: "shopper-secret-token",
  paMcpToken: "assistant-secret-token",
  serviceAccountId: "sa-shopper",
  paServiceAccountId: "sa-pa",
};
const setupInput = { clientMcpToken: "client-secret-token", commonRoomName: "common-room" };

async function setupGateway(handle: (req: Request) => Promise<Response>) {
  const res = await adminReq(handle, "POST", "/api/v1/setup", setupInput);
  expect(res.status).toBe(200);
}

test("setup and status require admin auth, and registration is gated until setup", async () => {
  const { ctx, handle } = makeTestApp();
  for (const token of ["", "wrong-admin-token"]) {
    expect((await adminReq(handle, "POST", "/api/v1/setup", setupInput, token)).status).toBe(401);
    expect((await adminReq(handle, "GET", "/api/v1/status", undefined, token)).status).toBe(401);
  }
  expect(await jsonBody(await adminReq(handle, "GET", "/api/v1/status")))
    .toMatchObject({ setupComplete: false, commonRoomName: null });
  const blocked = await adminReq(handle, "POST", "/api/v1/shoppers", registration);
  expect(blocked.status).toBe(409);
  expect((await jsonBody(blocked)).error).toContain("/api/v1/setup");
  expect(ctx.shoppers.list()).toHaveLength(0);
  expect(ctx.audit.recent()).toHaveLength(0);
  expect(ctx.gatewaySettings.getClientToken()).toBeNull();
  expect(ctx.gatewaySettings.getCommonRoomName()).toBeNull();
  await setupGateway(handle);
  expect((await adminReq(handle, "POST", "/api/v1/shoppers", registration)).status).toBe(201);
});

test("setup requires both inputs, rejects other config, and does not mutate on validation failure", async () => {
  const { ctx, handle } = makeTestApp();
  for (const body of [
    {},
    { clientMcpToken: setupInput.clientMcpToken },
    { commonRoomName: setupInput.commonRoomName },
    { ...setupInput, clientMcpToken: "" },
    { ...setupInput, clientMcpToken: "        " },
    { ...setupInput, commonRoomName: " " },
    { ...setupInput, commonRoomName: "x".repeat(81) },
    { ...setupInput, clientMcpToken: 42 },
    { ...setupInput, clientMcpToken: "x".repeat(4097) },
    { ...setupInput, unrelatedConfig: true },
  ]) {
    expect((await adminReq(handle, "POST", "/api/v1/setup", body)).status).toBe(422);
    expect(ctx.gatewaySettings.getStatus().setupComplete).toBe(false);
  }
  const malformed = await handle(new Request("http://test/api/v1/setup", {
    method: "POST",
    headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: "{bad json",
  }));
  expect(malformed.status).toBe(400);
  const oversized = await adminReq(handle, "POST", "/api/v1/setup",
    { ...setupInput, clientMcpToken: "x".repeat(1024 * 1024) });
  expect(oversized.status).toBe(413);
  await setupGateway(handle);
  expect((await adminReq(handle, "POST", "/api/v1/setup", { commonRoomName: "changed" })).status).toBe(422);
  expect(ctx.gatewaySettings.getCommonRoomName()).toBe(setupInput.commonRoomName);
  expect(ctx.gatewaySettings.getClientToken()).toBe(setupInput.clientMcpToken);
  expect((await adminReq(handle, "POST", "/api/v1/setup/extra", setupInput)).status).toBe(404);
});

test("setup updates one encrypted record and status, responses, logs and audits never expose tokens", async () => {
  const { db, ctx, handle, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  await setupGateway(handle);
  const nextToken = "replacement-client-secret";
  const response = await adminReq(handle, "POST", "/api/v1/setup", {
    clientMcpToken: nextToken,
    commonRoomName: "new-common",
  });
  expect(response.status).toBe(200);
  expect(await jsonBody(response)).toEqual({ setupComplete: true, commonRoomName: "new-common" });
  const status = await jsonBody(await adminReq(handle, "GET", "/api/v1/status"));
  expect(status).toMatchObject({ setupComplete: true, commonRoomName: "new-common", mcpConfigured: true });
  expect(ctx.gatewaySettings.getClientToken()).toBe(nextToken);
  const rows = db.query<{ client_token_encrypted: Uint8Array }, []>(
    "SELECT client_token_encrypted FROM gateway_settings",
  ).all();
  expect(rows).toHaveLength(1);
  expect(Buffer.from(rows[0]!.client_token_encrypted).includes(Buffer.from(nextToken))).toBe(false);

  const created = await jsonBody(await adminReq(handle, "POST", "/api/v1/shoppers", registration));
  const read = await jsonBody(await adminReq(handle, "GET", `/api/v1/shoppers/${created.shopper.id}`));
  expect(read.credentials.map((c: { label: string }) => c.label).sort()).toEqual(["pa", "shopper"]);
  expect(created.credential.serviceAccountId).toBe("sa-shopper");
  expect(created.paCredential.serviceAccountId).toBe("sa-pa");
  const serialized = JSON.stringify({ status, created, read, logs, audit: ctx.audit.recent() });
  for (const token of [setupInput.clientMcpToken, nextToken, registration.mcpToken, registration.paMcpToken]) {
    expect(serialized).not.toContain(token);
  }
  const audit = ctx.audit.recent().filter((entry) => entry.action === "gateway.setup");
  expect(audit).toHaveLength(2);
  expect(audit[0]!.detail?.clientTokenFingerprint).toBeString();
});

test("registration requires both tokens and nonblank identity fields without partial writes", async () => {
  const { ctx, handle } = makeTestApp();
  await setupGateway(handle);
  for (const field of ["mcpToken", "paMcpToken", "name", "phone", "roomName"] as const) {
    const body: Record<string, unknown> = { ...registration };
    delete body[field];
    expect((await adminReq(handle, "POST", "/api/v1/shoppers", body)).status).toBe(422);
  }
  for (const field of ["mcpToken", "paMcpToken", "name", "roomName"] as const) {
    expect((await adminReq(handle, "POST", "/api/v1/shoppers", { ...registration, [field]: "        " })).status).toBe(422);
  }
  expect(ctx.shoppers.list()).toHaveLength(0);
});

test("both credential roles rotate and revoke independently, with role-scoped audit", async () => {
  const { ctx, handle } = makeTestApp();
  await setupGateway(handle);
  const body = await jsonBody(await adminReq(handle, "POST", "/api/v1/shoppers", registration));
  const id = body.shopper.id;
  for (const role of ["shopper", "pa"] as const) {
    const otherRole = role === "shopper" ? "pa" : "shopper";
    const otherToken = ctx.credentials.getActiveToken(id, otherRole);
    const old = ctx.credentials.getActiveInfo(id, role)!;
    const token = `${role}-replacement-secret`;
    const res = await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/rotate`, {
      role, mcpToken: token,
    });
    expect(res.status).toBe(200);
    const rotated = await jsonBody(res);
    expect(rotated.credential.label).toBe(role);
    expect(JSON.stringify(rotated)).not.toContain(token);
    expect(ctx.credentials.getActiveToken(id, role)).toBe(token);
    expect(ctx.credentials.getById(old.id)?.status).toBe("revoked");
    expect(ctx.credentials.getActiveToken(id, otherRole)).toBe(otherToken);
    expect(ctx.credentials.listInfo(id).filter((c) => c.label === role && c.status === "active")).toHaveLength(1);
    const revoked = await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/revoke`, { role });
    expect(await jsonBody(revoked)).toEqual({ revoked: true });
    expect(ctx.credentials.getActiveToken(id, role)).toBeNull();
    expect(ctx.credentials.getActiveToken(id, otherRole)).toBe(otherToken);
    expect(await jsonBody(await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/revoke`, { role })))
      .toEqual({ revoked: false });
  }
  const actions = ctx.audit.recent().filter((a) => a.action.startsWith("credential."));
  expect(actions).toHaveLength(6);
  expect(actions.every((a) => a.detail?.role === "pa" || a.detail?.role === "shopper")).toBe(true);
});

test("rotate and revoke reject missing or invalid role, and unknown shoppers", async () => {
  const { ctx, handle } = makeTestApp();
  await setupGateway(handle);
  const body = await jsonBody(await adminReq(handle, "POST", "/api/v1/shoppers", registration));
  const id = body.shopper.id;
  for (const operation of ["rotate", "revoke"]) {
    for (const role of [undefined, "client", "assistant", null, 42]) {
      expect((await adminReq(handle, "POST", `/api/v1/shoppers/${id}/credential/${operation}`,
        { role, mcpToken: "replacement-secret" })).status).toBe(422);
    }
    expect((await adminReq(handle, "POST", `/api/v1/shoppers/unknown/credential/${operation}`,
      { role: "pa", mcpToken: "replacement-secret" })).status).toBe(404);
  }
  expect(ctx.credentials.getActiveToken(id, "shopper")).toBe(registration.mcpToken);
  expect(ctx.credentials.getActiveToken(id, "pa")).toBe(registration.paMcpToken);
});

test("re-registration fills a legacy PA identity and updates both tokens without enabling a disabled shopper", async () => {
  const { ctx, handle } = makeTestApp();
  const { shopper } = ctx.shoppers.register("Old name", registration.phone, "old-room");
  ctx.credentials.setActive(shopper.id, "legacy-token");
  ctx.shoppers.setStatus(shopper.id, "disabled");
  await setupGateway(handle);
  const invalidate = spyOn(ctx.adapter, "invalidate");
  const response = await adminReq(handle, "POST", "/api/v1/shoppers", registration);
  expect(response.status).toBe(200);
  const body = await jsonBody(response);
  expect(body.shopper).toMatchObject({
    id: shopper.id, status: "disabled", name: registration.name, roomName: registration.roomName,
  });
  expect(ctx.credentials.getActiveToken(shopper.id, "shopper")).toBe(registration.mcpToken);
  expect(ctx.credentials.getActiveToken(shopper.id, "pa")).toBe(registration.paMcpToken);
  expect(invalidate).toHaveBeenCalledWith(shopper.id);
  invalidate.mockRestore();
});

test("failed PA credential write rolls back shopper and both credentials on create and re-registration", async () => {
  const { ctx, db, handle } = makeTestApp();
  await setupGateway(handle);
  db.run(`CREATE TRIGGER fail_pa BEFORE INSERT ON shopper_credential WHEN NEW.label = 'pa'
    BEGIN SELECT RAISE(ABORT, 'test PA failure'); END;`);
  expect((await adminReq(handle, "POST", "/api/v1/shoppers", registration)).status).toBe(500);
  expect(ctx.shoppers.list()).toHaveLength(0);

  db.run("DROP TRIGGER fail_pa");
  const created = await jsonBody(await adminReq(handle, "POST", "/api/v1/shoppers", registration));
  db.run(`CREATE TRIGGER fail_pa BEFORE INSERT ON shopper_credential WHEN NEW.label = 'pa'
    BEGIN SELECT RAISE(ABORT, 'test PA failure'); END;`);
  const response = await adminReq(handle, "POST", "/api/v1/shoppers", {
    ...registration, name: "Changed", mcpToken: "changed-shopper", paMcpToken: "changed-pa",
  });
  expect(response.status).toBe(500);
  expect(ctx.shoppers.getById(created.shopper.id)?.name).toBe(registration.name);
  expect(ctx.credentials.getActiveToken(created.shopper.id, "shopper")).toBe(registration.mcpToken);
  expect(ctx.credentials.getActiveToken(created.shopper.id, "pa")).toBe(registration.paMcpToken);
  expect(ctx.credentials.listInfo(created.shopper.id)).toHaveLength(2);
  expect(ctx.audit.recent().filter((a) => a.action === "shopper.create")).toHaveLength(1);
});
