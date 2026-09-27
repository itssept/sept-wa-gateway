import { expect, test, afterEach } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import type { InboundMessage, RoutingGroup } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";

type AlbumApp = ReturnType<typeof makeTestApp> & {
  a: any;
  calls: Array<{ identity: PostingIdentity; input: any }>;
  dispatches: any[];
  reactions: Array<{ messageId: string; chatJid: string; emoji: string }>;
  router: InboundRouter;
};

const apps: AlbumApp[] = [];

function setupAlbumApp(opts: { debounceMs?: number } = {}): AlbumApp {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  ctx.credentials.setActive(a.id, `shopper-${a.id}`);
  ctx.credentials.setActive(a.id, `pa-${a.id}`, { label: "pa" });

  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  const dispatches: any[] = [];
  const reactions: Array<{ messageId: string; chatJid: string; emoji: string }> = [];

  const group: RoutingGroup = {
    linkedMember: true,
    participants: [
      { jid: "14155551111@s.whatsapp.net", phone_e164: "+14155551111" },
      { jid: "14155559999@s.whatsapp.net", phone_e164: "+14155559999" },
    ],
  };

  const adapter = {
    ask: async (identity: PostingIdentity, input: any) => {
      calls.push({ identity, input: structuredClone(input) });
      return { threadId: input.threadId ?? "test-bot-123", threadEventId: "test-event-456" };
    },
  };

  const router = new InboundRouter(
    ctx.resolver,
    adapter as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    {
      dispatch: async (input: unknown) => {
        dispatches.push(input);
      },
    } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => group,
      prepareHistory: async () => null,
      reactToMessage: async (m, emoji) => {
        reactions.push({ messageId: m.messageId, chatJid: m.chatJid, emoji });
      },
      relayUnregisteredChats: true,
      inboundDebounceMs: opts.debounceMs ?? 50,
    },
  );

  const res = { ...app, a, calls, dispatches, reactions, router };
  apps.push(res);
  return res;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

const GROUP_JID = "120363999@g.us";

function makeImageMessage(idx: number, caption: string = "", mentionsSelf = false): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: GROUP_JID,
    senderJid: "14155559999@s.whatsapp.net",
    senderPhoneE164: "+14155559999",
    pushName: "Sarah",
    messageId: `msg-img-${idx}`,
    ts: Date.now() + idx * 10,
    text: caption,
    msgType: "image",
    mediaStatus: "ready",
    media: {
      bytes: Buffer.from(`fake-image-bytes-${idx}`),
      mime: "image/jpeg",
      sizeBytes: 100,
    },
    isGroup: true,
    fromMe: false,
    mentionsSelf,
  };
}

test("Acceptance Criterion 1: A 5-image album produces one turn with all 5 images, verified by count", async () => {
  const app = setupAlbumApp({ debounceMs: 60 });

  const images = [
    makeImageMessage(1, "Can you find this jacket in black?"),
    makeImageMessage(2, ""),
    makeImageMessage(3, ""),
    makeImageMessage(4, ""),
    makeImageMessage(5, "@14155550000 check size 38", true),
  ];

  // Send all 5 messages within the debounce window
  const promises = images.map((img) => app.router.handle(img));
  await Promise.all(promises);

  // Verification 1: Exactly 1 client envelope ask call + 1 PA trigger ask call
  expect(app.calls).toHaveLength(2);

  const clientCall = app.calls[0];
  expect(clientCall.identity).toEqual({ role: "client" });
  expect(clientCall.input.agentResponse).toBe("force_skip");

  // Verification 2: All 5 images attached in the files array
  expect(clientCall.input.files).toBeDefined();
  expect(clientCall.input.files).toHaveLength(5);
  expect(clientCall.input.files.map((f: any) => f.mime_type)).toEqual([
    "image/jpeg",
    "image/jpeg",
    "image/jpeg",
    "image/jpeg",
    "image/jpeg",
  ]);

  // Verification 3: Verified by count across base64 payloads
  for (let i = 0; i < 5; i++) {
    const expectedBase64 = Buffer.from(`fake-image-bytes-${i + 1}`).toString("base64");
    expect(clientCall.input.files[i].content_base64).toBe(expectedBase64);
  }

  // Verification 4: Exactly one outbound dispatch for the entire 5-image album
  expect(app.dispatches).toHaveLength(1);
});

test("Acceptance Criterion 2: A mixed burst of images plus a caption stays together", async () => {
  const app = setupAlbumApp({ debounceMs: 60 });

  const m1 = makeImageMessage(1, ""); // image 1 without caption
  const m2 = makeImageMessage(2, ""); // image 2 without caption
  const m3: InboundMessage = {
    connectionId: "test-conn",
    chatJid: GROUP_JID,
    senderJid: "14155559999@s.whatsapp.net",
    senderPhoneE164: "+14155559999",
    pushName: "Sarah",
    messageId: "msg-text-3",
    ts: Date.now() + 30,
    text: "Looking for this bag with silver hardware in medium size @14155550000",
    msgType: "text",
    mediaStatus: "none",
    media: null,
    isGroup: true,
    fromMe: false,
    mentionsSelf: true,
  };

  await Promise.all([app.router.handle(m1), app.router.handle(m2), app.router.handle(m3)]);

  expect(app.calls).toHaveLength(2);

  const clientCall = app.calls[0];
  // 2 image files attached
  expect(clientCall.input.files).toHaveLength(2);

  // The text caption is preserved and stays together in the same client envelope
  expect(clientCall.input.query).toBe(
    "[Client] Sarah\n" +
    "[Phone] +14155559999\n" +
    "[Message] Looking for this bag with silver hardware in medium size @14155550000"
  );
});

test("Acceptance Criterion 3: No stray '(image)' turns in the transcript", async () => {
  const app = setupAlbumApp({ debounceMs: 60 });

  // Burst with multiple images and captions
  const m1 = makeImageMessage(1, "Front view of item");
  const m2 = makeImageMessage(2, "");
  const m3 = makeImageMessage(3, "");
  const m4 = makeImageMessage(4, "Back tag and lining @14155550000", true);

  await Promise.all([
    app.router.handle(m1),
    app.router.handle(m2),
    app.router.handle(m3),
    app.router.handle(m4),
  ]);

  const clientCall = app.calls[0];

  // Inspect query text: MUST NOT contain stray "(image)" lines
  expect(clientCall.input.query).not.toContain("(image)");
  expect(clientCall.input.query).toBe(
    "[Client] Sarah\n" +
    "[Phone] +14155559999\n" +
    "[Message] Front view of item\n" +
    "Back tag and lining @14155550000"
  );

  // Total turns produced: exactly 1 client envelope turn, not 4 separate turns
  const clientEnvelopes = app.calls.filter((c) => c.identity.role === "client");
  expect(clientEnvelopes).toHaveLength(1);
});

test("Uncaptioned stand-alone single image or multi-image burst without text has single (image) label", async () => {
  const app = setupAlbumApp({ debounceMs: 60 });

  const m1 = makeImageMessage(1, "");
  const m2 = makeImageMessage(2, "");

  await Promise.all([app.router.handle(m1), app.router.handle(m2)]);

  const clientCall = app.calls[0];
  expect(clientCall.input.files).toHaveLength(2);
  expect(clientCall.input.query).toBe(
    "[Client] Sarah\n" +
    "[Phone] +14155559999\n" +
    "[Message] (image)"
  );
});