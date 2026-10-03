import { expect, test } from "bun:test";
import jpeg from "jpeg-js";
import {
  normalizePromptQlFile, recompressPromptQlFile, recompressForBridge, baseMime, promptQlFileMeta,
} from "../src/promptql/mediaFiles.ts";

function tinyJpeg(width = 8, height = 8, quality = 90): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; data[i + 1] = 40; data[i + 2] = 40; data[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, quality).data);
}

test("baseMime strips parameters", () => {
  expect(baseMime("image/jpeg; codecs=something")).toBe("image/jpeg");
});

test("normalizePromptQlFile strips mime params and aligns extension", () => {
  const bytes = tinyJpeg();
  const file = normalizePromptQlFile({
    file_name: "whatsapp-image-abc",
    mime_type: "image/jpeg; charset=binary",
    content_base64: bytes.toString("base64"),
  });
  expect(file.mime_type).toBe("image/jpeg");
  expect(file.file_name.endsWith(".jpg")).toBe(true);
});

test("normalizePromptQlFile sniffs JPEG magic over octet-stream", () => {
  const bytes = tinyJpeg();
  const file = normalizePromptQlFile({
    file_name: "blob.bin",
    mime_type: "application/octet-stream",
    content_base64: bytes.toString("base64"),
  });
  expect(file.mime_type).toBe("image/jpeg");
  expect(file.file_name.endsWith(".jpg")).toBe(true);
});

test("recompressPromptQlFile shrinks large JPEG", () => {
  // Noise-filled canvas so JPEG stays large enough to trigger recompress.
  const width = 2400, height = 2400;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
  const bytes = Buffer.from(jpeg.encode({ data, width, height }, 100).data);
  expect(bytes.length).toBeGreaterThan(900 * 1024);
  const input = {
    file_name: "photo.jpg",
    mime_type: "image/jpeg",
    content_base64: bytes.toString("base64"),
  };
  const out = recompressPromptQlFile(input);
  const meta = promptQlFileMeta(out);
  expect(meta.mime).toBe("image/jpeg");
  expect(meta.bytes).toBeLessThan(bytes.length);
  expect(meta.bytes).toBeLessThanOrEqual(900 * 1024);
});

test("recompressForBridge leaves a small JPEG unchanged and shrinks a large one", () => {
  const small = tinyJpeg(32, 32, 40);
  expect(small.length).toBeLessThanOrEqual(220 * 1024);
  const unchanged = recompressForBridge({
    file_name: "small.jpg",
    mime_type: "image/jpeg",
    content_base64: small.toString("base64"),
  });
  expect(unchanged.content_base64).toBe(small.toString("base64"));

  const width = 900;
  const height = 900;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 255;
  const bytes = Buffer.from(jpeg.encode({ data, width, height }, 95).data);
  expect(bytes.length).toBeGreaterThan(220 * 1024);
  const out = recompressForBridge({
    file_name: "bridge.jpg",
    mime_type: "image/jpeg",
    content_base64: bytes.toString("base64"),
  });
  const meta = promptQlFileMeta(out);
  expect(meta.mime).toBe("image/jpeg");
  expect(meta.bytes).toBeLessThanOrEqual(220 * 1024);
  expect(meta.bytes).toBeLessThan(bytes.length);
});
