/**
 * Connection management API: status, link (canonicalize + start pairing),
 * unlink, auth, validation. Uses a FakeConnection stub.
 */

import { test, expect } from "bun:test";
import { makeTestApp, adminReq, jsonBody, FakeConnection, testConfig } from "./helpers.ts";

test("GET /connection returns status; 503 when no connection", async () => {
  const withConn = makeTestApp(testConfig(), new FakeConnection());
  const res = await adminReq(withConn.handle, "GET", "/api/v1/connection");
  expect(res.status).toBe(200);
  const body = await jsonBody(res);
  expect(body.connection.status).toBe("pending");

  const noConn = makeTestApp();
  const res2 = await adminReq(noConn.handle, "GET", "/api/v1/connection");
  expect(res2.status).toBe(503);
});

test("link canonicalizes the phone and starts pairing", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
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

test("link rejects an invalid phone", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  const res = await adminReq(app.handle, "POST", "/api/v1/connection/link", { phone: "abc" });
  expect(res.status).toBe(422);
  expect(app.connection!.linkCalls.length).toBe(0);
});

test("unlink stops + wipes", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  app.connection!.status = "linked";
  const res = await adminReq(app.handle, "POST", "/api/v1/connection/unlink");
  expect(res.status).toBe(200);
  expect(app.connection!.unlinkCalls).toBe(1);
  const body = await jsonBody(res);
  expect(body.connection.status).toBe("logged_out");
});

test("connection endpoints require the admin token", async () => {
  const app = makeTestApp(testConfig(), new FakeConnection());
  const res = await adminReq(app.handle, "GET", "/api/v1/connection", undefined, "");
  expect(res.status).toBe(401);
});
