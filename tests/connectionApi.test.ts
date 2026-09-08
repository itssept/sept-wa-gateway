/**
 * Connection management API: status, setup-gated link (canonicalize + start
 * pairing), unlink, auth, validation. Uses a FakeConnection stub.
 */

import { test, expect } from "bun:test";
import { makeTestApp, adminReq, jsonBody, FakeConnection, testConfig } from "./helpers.ts";

async function completeSetup(app: ReturnType<typeof makeTestApp>) {
  const res = await adminReq(app.handle, "POST", "/api/v1/setup", {
    clientMcpToken: "test-client-mcp-token",
    commonRoomName: "sept-common",
  });
  expect(res.status).toBe(200);
  expect(app.ctx.gatewaySettings.getStatus().setupComplete).toBe(true);
}

test("GET /connection returns status before setup; 503 when no connection", async () => {
  const withConn = makeTestApp(testConfig(), new FakeConnection());
  expect(withConn.ctx.gatewaySettings.getStatus().setupComplete).toBe(false);
  const res = await adminReq(withConn.handle, "GET", "/api/v1/connection");
  expect(res.status).toBe(200);
  const body = await jsonBody(res);
  expect(body.connection.status).toBe("pending");

  const noConn = makeTestApp();
  const res2 = await adminReq(noConn.handle, "GET", "/api/v1/connection");
  expect(res2.status).toBe(503);
});

for (const status of ["pending", "linked"] as const) {
  test(`link requires setup and leaves a ${status} connection unchanged`, async () => {
    const connection = new FakeConnection();
    connection.status = status;
    if (status === "linked") {
      connection.number = "+14155559999";
      connection.linkedAtMs = 123;
    }
    const app = makeTestApp(testConfig(), connection);
    const before = await jsonBody(await adminReq(app.handle, "GET", "/api/v1/connection"));
    const res = await adminReq(app.handle, "POST", "/api/v1/connection/link", {
      phone: "+14155551212",
    });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({
      error: "gateway setup required: POST /api/v1/setup with clientMcpToken and commonRoomName",
    });
    expect(connection.linkCalls).toEqual([]);
    expect(connection.unlinkCalls).toBe(0);
    expect(await jsonBody(await adminReq(app.handle, "GET", "/api/v1/connection"))).toEqual(before);
  });
}

test("link canonicalizes the phone and starts pairing after setup", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  await completeSetup(app);
  const res = await adminReq(app.handle, "POST", "/api/v1/connection/link", {
    phone: "+1 (415) 555-1212",
    deviceLabel: "sept-gateway",
  });
  expect(res.status).toBe(202);
  expect(app.connection!.linkCalls).toEqual([
    { number: "+14155551212", deviceLabel: "sept-gateway" },
  ]);
  const body = await jsonBody(res);
  expect(body.connection.pairingCode).toBe("ABCD-1234");
});

test("link rejects an invalid phone after setup", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  await completeSetup(app);
  const res = await adminReq(app.handle, "POST", "/api/v1/connection/link", { phone: "abc" });
  expect(res.status).toBe(422);
  expect(app.connection!.linkCalls.length).toBe(0);
});

test("unlink stops + wipes before setup", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  expect(app.ctx.gatewaySettings.getStatus().setupComplete).toBe(false);
  app.connection!.status = "linked";
  const res = await adminReq(app.handle, "POST", "/api/v1/connection/unlink");
  expect(res.status).toBe(200);
  expect(app.connection!.unlinkCalls).toBe(1);
  const body = await jsonBody(res);
  expect(body.connection.status).toBe("logged_out");
});

for (const [method, path] of [
  ["GET", "/api/v1/connection"],
  ["POST", "/api/v1/connection/link"],
  ["POST", "/api/v1/connection/unlink"],
] as const) {
  test(`${method} ${path} requires the admin token before setup`, async () => {
    const app = makeTestApp(testConfig(), new FakeConnection());
    const res = await adminReq(app.handle, method, path, undefined, "");
    expect(res.status).toBe(401);
    expect(app.connection!.linkCalls).toEqual([]);
    expect(app.connection!.unlinkCalls).toBe(0);
  });
}
