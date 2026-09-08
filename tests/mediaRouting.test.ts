import { expect, test } from "bun:test";
import { mediaFileName, promptQlQuery } from "../src/routing/inboundRouter.ts";
import { clientQuery } from "../src/routing/groupRelay.ts";
import { setup, msg } from "./routingHelpers.ts";

test("shopper media uses caption unchanged or kind only, without provenance", () => {
  expect(promptQlQuery(msg({ text: "  keep me\nexactly ", msgType: "image" }))).toBe("  keep me\nexactly ");
  expect(promptQlQuery(msg({ text: "", msgType: "image" }))).toBe("(image)");
  expect(promptQlQuery(msg({ text: "", msgType: "text" }))).toBeNull();
  expect(mediaFileName("abc/123", "image", "image/jpeg")).toBe("whatsapp-image-abc_123.jpg");
});

test("Client media labels preserve filename, voice note, contact and location without conversion", () => {
  for (const [kind, ptt, label] of [
    ["document", false, "document: invoice.pdf"], ["audio", true, "voice note"],
    ["contact", false, "contact card"], ["location", false, "location"],
  ] as const) {
    expect(clientQuery(msg({ senderPhoneE164: null, senderJid: "123@lid", pushName: "Priya", msgType: kind, fileName: "invoice.pdf", ptt, text: "", mediaStatus: "expired" })))
      .toBe(`[Client] Priya, 123@lid\n(${label})`);
  }
});

for (const isGroup of [true, false]) {
  test(`${isGroup ? "group" : "DM"} media attaches through helper and releases bytes on success and failure`, async () => {
    const app = setup();
    try {
      for (const fail of [false, true]) {
        let received: any;
        app.setAskHook(async (_identity, input) => {
          received = structuredClone(input);
          if (fail) throw new Error("MCP unavailable");
        });
        const input = msg({ isGroup, chatJid: isGroup ? "120363123@g.us" : "14155551111@s.whatsapp.net",
          text: "", msgType: "document", fileName: "invoice.pdf", mediaStatus: "ready",
          media: { bytes: Buffer.from("file"), mime: "application/pdf", fileName: "invoice.pdf", sizeBytes: 4 } });
        await app.router.handle(input);
        expect(received.files).toEqual([{ file_name: "invoice.pdf", mime_type: "application/pdf", content_base64: "ZmlsZQ==" }]);
        expect(received.query).toBe("(document: invoice.pdf)");
        expect(input.media).toBeNull();
      }
    } finally { app.db.close(); }
  });
}
