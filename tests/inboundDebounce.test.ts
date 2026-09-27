import { expect, test, afterEach } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import type { InboundMessage, RoutingGroup } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";

type DebounceApp = ReturnType<typeof makeTestApp> & {
  a: any;
  b: any;
  calls: Array<{ identity: PostingIdentity; input: any }>;
  dispatches: any[];
  reactions: Array<{ messageId: string; chatJid: string; emoji: string }>;
  router: InboundRouter;
};

const apps: DebounceApp[] = [];

function setupDebounceApp(opts: { debounceMs?: number } = {}): DebounceApp {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  const b = ctx.shoppers.register("Bob", "+14155552222", "bob-room").shopper;
  for (const s of [a, b]) {
    ctx.credentials.setActive(s.id, `shopper-${s.id}`);
    ctx.credentials.setActive(s.id, `pa-${s.id}`, { label: "pa" });
  }

  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  const dispatches: any[] = [];
  const reactions: Array<{ messageId: string; chatJid: string; emoji: string }> = [];

  const group: RoutingGroup = {
    linkedMember: true,
    participants: [
      { jid: "14155551111@s.whatsapp.net", phone_e164: "+14155551111" },
      { jid: "14155552222@s.whatsapp.net", phone_e164: "+14155552222" },
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
      inboundDebounceMs: opts.debounceMs ?? 50, // 50ms in tests for fast execution
    },
  );

  const res = { ...app, a, b, calls, dispatches, reactions, router };
  apps.push(res);
  return res;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

const GROUP_JID = "120363123@g.us";

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: GROUP_JID,
    senderJid: "14155559999@s.whatsapp.net",
    senderPhoneE164: "+14155559999",
    pushName: "Sarah",
    messageId: crypto.randomUUID(),
    ts: Date.now(),
    text: "Part of request",
    msgType: "text",
    mediaStatus: "none",
    media: null,
    isGroup: true,
    fromMe: false,
    mentionsSelf: false,
    ...overrides,
  };
}

test("Acceptance Criterion 1: 3 messages sent within the window produce 1 turn and 1 reply covering all three requests", async () => {
  const app = setupDebounceApp({ debounceMs: 60 });

  const m1 = makeInbound({
    messageId: "msg-1",
    text: "Can you find a Chanel classic flap in black?",
    mentionsSelf: false,
  });
  const m2 = makeInbound({
    messageId: "msg-2",
    text: "Size medium with gold hardware please.",
    mentionsSelf: false,
  });
  const m3 = makeInbound({
    messageId: "msg-3",
    text: "@14155550000 also check if there is caviar leather available.",
    mentionsSelf: true,
  });

  // Send 3 rapid messages
  const p1 = app.router.handle(m1);
  const p2 = app.router.handle(m2);
  const p3 = app.router.handle(m3);

  await Promise.all([p1, p2, p3]);

  // Verify only 1 promptql ask call occurred for the client
  expect(app.calls).toHaveLength(2); // 1 client envelope submission + 1 PA trigger submission

  const clientCall = app.calls[0];
  expect(clientCall.identity).toEqual({ role: "client" });
  expect(clientCall.input.agentResponse).toBe("force_skip");

  // Verify merged query format
  expect(clientCall.input.query).toBe(
    "[Client] Sarah\n" +
    "[Phone] +14155559999\n" +
    "[Message] Can you find a Chanel classic flap in black?\n" +
    "Size medium with gold hardware please.\n" +
    "@14155550000 also check if there is caviar leather available."
  );

  const paCall = app.calls[1];
  expect(paCall.identity).toEqual({ role: "pa", shopperId: app.a.id });
  expect(paCall.input.agentResponse).toBe("force_respond");
  expect(paCall.input.query).toBe("Please respond to the client message above on behalf of Alice.");

  // Verify 1 dispatch produced for the combined turn
  expect(app.dispatches).toHaveLength(1);
  expect(app.dispatches[0].idempotencyKey).toBe("msg-3");

  // Verify reaction acknowledged on the triggering message
  expect(app.reactions).toHaveLength(1);
  expect(app.reactions[0]).toEqual({
    messageId: "msg-3",
    chatJid: GROUP_JID,
    emoji: "👀",
  });
});

test("Acceptance Criterion 2: Messages spaced beyond the window produce separate turns", async () => {
  const app = setupDebounceApp({ debounceMs: 30 });

  const m1 = makeInbound({
    messageId: "msg-turn1",
    text: "First request",
    mentionsSelf: true,
  });

  await app.router.handle(m1);

  // Wait for turn 1 to flush
  expect(app.calls.length).toBeGreaterThanOrEqual(1);
  const initialCallsCount = app.calls.length;

  // Wait beyond debounce window
  await new Promise((r) => setTimeout(r, 50));

  const m2 = makeInbound({
    messageId: "msg-turn2",
    text: "Second request after window expired",
    mentionsSelf: true,
  });

  await app.router.handle(m2);

  // Expect distinct calls and dispatches
  expect(app.calls.length).toBe(initialCallsCount + 2); // new client relay + new PA trigger
  expect(app.dispatches).toHaveLength(2);
  expect(app.dispatches[0].idempotencyKey).toBe("msg-turn1");
  expect(app.dispatches[1].idempotencyKey).toBe("msg-turn2");
});

test("Acceptance Criterion 3: Buffers are per client (phone/LID), so two clients never merge", async () => {
  const app = setupDebounceApp({ debounceMs: 60 });

  const client1Msg1 = makeInbound({
    senderPhoneE164: "+14155559999",
    senderJid: "14155559999@s.whatsapp.net",
    pushName: "Sarah",
    text: "Sarah request 1",
  });
  const client2Msg1 = makeInbound({
    senderPhoneE164: "+14155558888",
    senderJid: "14155558888@s.whatsapp.net",
    pushName: "Jessica",
    text: "Jessica request 1",
  });
  const client1Msg2 = makeInbound({
    senderPhoneE164: "+14155559999",
    senderJid: "14155559999@s.whatsapp.net",
    pushName: "Sarah",
    text: "Sarah request 2",
  });

  // Interleave messages from two different clients in the same group chat
  const p1 = app.router.handle(client1Msg1);
  const p2 = app.router.handle(client2Msg1);
  const p3 = app.router.handle(client1Msg2);

  await Promise.all([p1, p2, p3]);

  // Find client envelopes
  const sarahCall = app.calls.find((c) => c.input.query.includes("Sarah request 1"));
  const jessicaCall = app.calls.find((c) => c.input.query.includes("Jessica request 1"));

  expect(sarahCall).toBeDefined();
  expect(jessicaCall).toBeDefined();

  // Sarah's merged envelope has both of Sarah's messages, none of Jessica's
  expect(sarahCall!.input.query).toContain("Sarah request 1\nSarah request 2");
  expect(sarahCall!.input.query).not.toContain("Jessica");

  // Jessica's envelope only has Jessica's message
  expect(jessicaCall!.input.query).toContain("Jessica request 1");
  expect(jessicaCall!.input.query).not.toContain("Sarah");
});

test("Acceptance Criterion 3b: LID clients maintain separate buffers from phone clients", async () => {
  const app = setupDebounceApp({ debounceMs: 60 });

  const lidMsg = makeInbound({
    senderPhoneE164: null,
    senderJid: "99887766@lid",
    pushName: "LID User",
    text: "Message from LID client",
  });

  const phoneMsg = makeInbound({
    senderPhoneE164: "+14155559999",
    senderJid: "14155559999@s.whatsapp.net",
    pushName: "Phone User",
    text: "Message from phone client",
  });

  await Promise.all([app.router.handle(lidMsg), app.router.handle(phoneMsg)]);

  const lidCall = app.calls.find((c) => c.input.query.includes("[ID] 99887766@lid"));
  const phoneCall = app.calls.find((c) => c.input.query.includes("[Phone] +14155559999"));

  expect(lidCall).toBeDefined();
  expect(phoneCall).toBeDefined();

  expect(lidCall!.input.query).toContain("Message from LID client");
  expect(lidCall!.input.query).not.toContain("Message from phone client");
  expect(phoneCall!.input.query).toContain("Message from phone client");
  expect(phoneCall!.input.query).not.toContain("Message from LID client");
});

test("Media attachments across buffered messages are attached to the PromptQL turn", async () => {
  const app = setupDebounceApp({ debounceMs: 60 });

  const m1 = makeInbound({
    messageId: "msg-media-1",
    text: "Check this bag",
    msgType: "image",
    mediaStatus: "ready",
    media: {
      bytes: Buffer.from("fake-img-1"),
      mime: "image/jpeg",
      sizeBytes: 10,
    },
  });

  const m2 = makeInbound({
    messageId: "msg-media-2",
    text: "And here is the info",
    mentionsSelf: true,
  });

  await Promise.all([app.router.handle(m1), app.router.handle(m2)]);

  const clientCall = app.calls[0];
  expect(clientCall.input.files).toHaveLength(1);
  expect(clientCall.input.files[0].mime_type).toBe("image/jpeg");
  expect(clientCall.input.query).toBe(
    "[Client] Sarah\n" +
    "[Phone] +14155559999\n" +
    "[Message] Check this bag\n" +
    "And here is the info"
  );
});