import { expect, test } from "bun:test";
import {
  EphemeralMediaStore, contentDispositionInline, ephemeralMediaUrl, isEphemeralMediaPath,
  safeContentType,
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

test("store put/take is single-use and expires", () => {
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from([1, 2, 3]),
    mimeType: "image/jpeg",
    fileName: "a.jpg",
    ttlMs: 60_000,
  });
  expect(token).toHaveLength(48);
  const first = store.take(token);
  expect(first?.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
  expect(store.take(token)).toBeNull();
});

test("GET ephemeral-media serves bytes without admin auth", async () => {
  const app = makeTestApp();
  const store = new EphemeralMediaStore();
  const token = store.put({
    bytes: Buffer.from("hello-photo"),
    mimeType: "image/jpeg",
    fileName: "x.jpg",
  });
  const handle = makeHandler({ ctx: app.ctx, ephemeralMedia: store });
  const res = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(await res.text()).toBe("hello-photo");
  // single-use
  const res2 = await handle(new Request(`http://localhost/api/v1/ephemeral-media/${token}`));
  expect(res2.status).toBe(404);
  // admin routes still require auth
  const unauthorized = await handle(new Request("http://localhost/api/v1/status"));
  expect(unauthorized.status).toBe(401);
  app.db.close();
});
