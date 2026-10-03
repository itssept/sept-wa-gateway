import { expect, test } from "bun:test";
import {
  EphemeralMediaStore, contentDispositionInline, ephemeralMediaUrl, isEphemeralMediaPath,
  publicBaseUrlUsesNonStandardPort, safeContentType,
} from "../src/http/ephemeralMedia.ts";
import { makeHandler } from "../src/http/adminApi.ts";
import { makeTestApp } from "./helpers.ts";

test("content headers cannot inject", () => {
  expect(safeContentType("image/jpeg")).toBe("image/jpeg");
  expect(safeContentType("image/jpeg\r\nX-Injected: 1")).toBe("application/octet-stream");
  expect(contentDispositionInline("a.jpg\r\nSet-Cookie: x")).toBe('inline; filename="a.jpg_Set-Cookie_ x"');
  expect(contentDispositionInline("a.jpg\r\nSet-Cookie: x")).not.toContain("\r");
});

test("ephemeralMediaUrl and path parsing", () => {
  const token = "a".repeat(48);
  expect(ephemeralMediaUrl("http://example.test:8790/", token))
    .toBe(`http://example.test:8790/api/v1/ephemeral-media/${token}`);
  expect(isEphemeralMediaPath(`/api/v1/ephemeral-media/${token}`)).toBe(token);
  expect(isEphemeralMediaPath("/api/v1/ephemeral-media/nope")).toBeNull();
});

test("publicBaseUrlUsesNonStandardPort detects :8790", () => {
  expect(publicBaseUrlUsesNonStandardPort("http://64.225.89.130:8790")).toBe(true);
  expect(publicBaseUrlUsesNonStandardPort("http://64.225.89.130")).toBe(false);
  expect(publicBaseUrlUsesNonStandardPort("https://media.example.com")).toBe(false);
  expect(publicBaseUrlUsesNonStandardPort("https://media.example.com:443")).toBe(false);
});

test("store put/take defaults to multi-fetch then burns", () => {
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from([1, 2, 3]),
    mimeType: "image/jpeg",
    fileName: "a.jpg",
    ttlMs: 60_000,
    maxFetches: 2,
  });
  expect(token).toHaveLength(48);
  expect(store.peek(token)?.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
  expect(store.take(token)?.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
  expect(store.take(token)?.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
  expect(store.take(token)).toBeNull();
});

test("default maxFetches allows a HEAD-then-GET probe plus retries", () => {
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from([4, 5]),
    mimeType: "image/jpeg",
    fileName: "c.jpg",
  });
  expect(store.peek(token)?.remainingFetches).toBe(8);
  for (let i = 0; i < 8; i++) {
    expect(store.take(token)?.bytes.equals(Buffer.from([4, 5]))).toBe(true);
  }
  expect(store.take(token)).toBeNull();
});

test("maxFetches 1 is legacy single-use", () => {
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from([9]),
    mimeType: "image/jpeg",
    fileName: "b.jpg",
    maxFetches: 1,
  });
  expect(store.take(token)?.bytes.equals(Buffer.from([9]))).toBe(true);
  expect(store.take(token)).toBeNull();
});

test("GET ephemeral-media serves bytes without admin auth; HEAD peeks", async () => {
  const app = makeTestApp();
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from("hello-photo"),
    mimeType: "image/jpeg",
    fileName: "x.jpg",
    maxFetches: 2,
  });
  const handle = makeHandler({ ctx: app.ctx, ephemeralMedia: store });
  const head = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("image/jpeg");
  expect(head.headers.get("content-length")).toBe(String(Buffer.from("hello-photo").length));
  expect(await head.text()).toBe("");
  // peek must not burn
  const res = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello-photo");
  const res2 = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`));
  expect(res2.status).toBe(200);
  expect(await res2.text()).toBe("hello-photo");
  const res3 = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`));
  expect(res3.status).toBe(404);
  // unknown token HEAD is 404, not admin 401
  const missingHead = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${"b".repeat(48)}`, { method: "HEAD" }));
  expect(missingHead.status).toBe(404);
  // admin routes still require auth
  const unauthorized = await handle(new Request("http://localhost/api/v1/status"));
  expect(unauthorized.status).toBe(401);
  app.db.close();
});
