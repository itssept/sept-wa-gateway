import { expect, test } from "bun:test";
import {
  InboundRouter,
  mediaFileName,
  promptQlQuery,
} from "../src/routing/inboundRouter.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";

function inbound(
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: "14155551212@s.whatsapp.net",
    senderJid: "14155551212@s.whatsapp.net",
    senderPhoneE164: "+14155551212",
    messageId: "message-1",
    ts: Date.now(),
    text: "",
    msgType: "image",
    mediaStatus: "ready",
    media: {
      bytes: Buffer.from("image"),
      mime: "image/jpeg",
      sizeBytes: 5,
    },
    isGroup: false,
    fromMe: false,
    mentionsSelf: false,
    ...overrides,
  };
}

test("media-only messages describe the PromptQL file attachment", () => {
  expect(promptQlQuery(inbound(), true)).toBe(
    "[WhatsApp image attached; media is included as a PromptQL file attachment; " +
      "chat_id=14155551212@s.whatsapp.net; message_id=message-1]",
  );
});

test("builds a safe attachment filename from message metadata", () => {
  expect(mediaFileName("abc/123", "image", "image/jpeg")).toBe(
    "whatsapp-image-abc_123.jpg",
  );
});

test("captions are preserved and unavailable media is explicit", () => {
  const query = promptQlQuery(
    inbound({ text: "Please identify this", mediaStatus: "too_large", media: null }),
  );
  expect(query).toContain("Please identify this");
  expect(query).toContain("unavailable (too_large)");
});

test("empty non-media messages remain ignored", () => {
  expect(
    promptQlQuery(inbound({ msgType: "text", mediaStatus: "none", media: null })),
  ).toBeNull();
});


function makeRouter(ask: (input: unknown) => Promise<unknown>) {
  return new InboundRouter(
    {
      resolve: () => ({
        ok: true,
        via: "sender",
        shopper: { id: "shopper-1", roomName: "sept-room" },
      }),
    } as never,
    { ask: (_shopperId: string, input: unknown) => ask(input) } as never,
    {
      create: () => ({ id: "workflow-1" }),
    } as never,
    {
      get: () => null,
      upsert: () => undefined,
    } as never,
    {
      claim: () => ({ status: "claimed", token: "claim-1" }),
      markFailed: () => true,
    } as never,
    {
      dispatch: async () => undefined,
    } as never,
    {
      record: () => undefined,
    } as never,
    {
      child: () => ({
        info: () => undefined,
        error: () => undefined,
      }),
    } as never,
  );
}

test("router attaches transient bytes and releases them after MCP accepts", async () => {
  const msg = inbound();
  let received: any;
  const router = makeRouter(async (input) => {
    // Capture what crossed the adapter boundary. The router deliberately clears
    // its own temporary array after the awaited submission.
    received = structuredClone(input);
    return { threadId: "thread-1", threadEventId: "event-1" };
  });

  await router.handle(msg);

  expect(received.files).toEqual([
    {
      file_name: "whatsapp-image-message-1.jpg",
      mime_type: "image/jpeg",
      content_base64: "aW1hZ2U=",
    },
  ]);
  expect(msg.media).toBeNull();
});

test("router releases transient bytes when MCP submission fails", async () => {
  const msg = inbound();
  const router = makeRouter(async () => {
    throw new Error("MCP unavailable");
  });

  await router.handle(msg);

  expect(msg.media).toBeNull();
});
