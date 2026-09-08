import { expect, test } from "bun:test";
import type { WAMessage } from "baileys";
import { createLogger } from "../src/logger.ts";
import {
  TransientMediaDownloader,
  classifyMessage,
  hasMedia,
} from "../src/whatsapp/media.ts";

const log = createLogger({ level: "error", sink: () => undefined });
const socket = { updateMediaMessage: async () => undefined } as never;

function message(content: Record<string, unknown>, id = "message-1"): WAMessage {
  return {
    key: { id, remoteJid: "14155551212@s.whatsapp.net" },
    message: content,
  } as WAMessage;
}

function implementation(...chunks: Uint8Array[]) {
  return async () =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
}

test("detects and classifies supported media without treating text as media", () => {
  const text = message({ conversation: "hello" });
  const image = message({
    imageMessage: { mimetype: "image/jpeg", fileLength: 3 },
  });
  expect(hasMedia(text)).toBe(false);
  expect(classifyMessage(text)).toBe("text");
  expect(hasMedia(image)).toBe(true);
  expect(classifyMessage(image)).toBe("image");
});

test("returns downloaded media only in transient memory", async () => {
  const downloader = new TransientMediaDownloader(
    1024,
    log,
    implementation(Buffer.from("abc")),
  );
  const result = await downloader.download(
    message({ imageMessage: { mimetype: "image/jpeg", fileLength: 3 } }),
    socket,
  );

  expect(result.status).toBe("ready");
  expect(result.media?.mime).toBe("image/jpeg");
  expect(result.media?.sizeBytes).toBe(3);
  expect(result.media?.bytes.toString()).toBe("abc");
});

test("rejects declared and actual media sizes above the configured cap", async () => {
  let downloadCalls = 0;
  const neverDownload = async () => {
    downloadCalls++;
    return implementation(Buffer.from("unused"))();
  };
  const declaredDownloader = new TransientMediaDownloader(3, log, neverDownload);
  const declared = await declaredDownloader.download(
    message({ documentMessage: { fileLength: 4 } }),
    socket,
  );
  expect(declared).toEqual({ status: "too_large", media: null });
  expect(downloadCalls).toBe(0);

  const streamedDownloader = new TransientMediaDownloader(
    3,
    log,
    implementation(Buffer.from("ab"), Buffer.from("cd")),
  );
  const streamed = await streamedDownloader.download(
    message({ documentMessage: {} }),
    socket,
  );
  expect(streamed).toEqual({ status: "too_large", media: null });
});

test("records expired downloads as an honest availability gap", async () => {
  const downloader = new TransientMediaDownloader(1024, log, async () => {
    throw new Error("HTTP 410: media expired");
  });
  const result = await downloader.download(
    message({ videoMessage: { mimetype: "video/mp4" } }),
    socket,
  );
  expect(result).toEqual({ status: "expired", media: null });
});


test.each([
  ["invoice_0912.pdf", "invoice_0912.pdf"],
  ["../../invoice.pdf", "invoice.pdf"],
  ["C:\\private\\invoice.pdf", "invoice.pdf"],
  ["invoice\n.pdf", "invoice_.pdf"],
  ["...", "..."],
  ["..", undefined],
  [null, undefined],
  [42, undefined],
])("document download preserves a safe original filename: %s", async (fileName, expected) => {
  const downloader = new TransientMediaDownloader(1024, log, implementation(Buffer.from("pdf")));
  const result = await downloader.download(message({
    documentMessage: { mimetype: "application/pdf", fileName },
  }), socket);
  expect(result.status).toBe("ready");
  expect(result.media?.fileName).toBe(expected);
  expect(result.media?.bytes.toString()).toBe("pdf");
});
