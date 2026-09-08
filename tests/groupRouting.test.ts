import { expect, test } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { senderLabel, groupQuery } from "../src/routing/groupRelay.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";

const GROUP = "120363123@g.us";
function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectionId: "test-conn", chatJid: GROUP,
    senderJid: "14155551111@s.whatsapp.net", senderPhoneE164: "+14155551111",
    messageId: crypto.randomUUID(), ts: Date.now(), text: "hello @14155550000",
    msgType: "text", mediaStatus: "none", media: null, isGroup: true,
    fromMe: false, mentionsSelf: false, ...overrides,
  };
}
function setup() {
  const app = makeTestApp();
  const { ctx } = app;
  const a = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  const b = ctx.shoppers.register("Bob", "+14155552222", "bob-room").shopper;
  for (const shopper of [a, b]) ctx.credentials.setActive(shopper.id, `token-${shopper.id}`);
  const calls: Array<{ shopperId: string; input: any }> = [];
  const dispatches: any[] = [];
  let askHook: (() => Promise<void>) | undefined;
  const adapter = {
    ask: async (shopperId: string, input: any) => {
      calls.push({ shopperId, input: structuredClone(input) });
      await askHook?.();
      return { threadId: input.threadId ?? "shared-bot", threadEventId: "event" };
    },
  };
  const router = new InboundRouter(
    ctx.resolver, adapter as never, ctx.workflows, ctx.chatBots, ctx.outboundLog,
    { dispatch: async (input: unknown) => { dispatches.push(input); } } as never,
    ctx.audit, ctx.log,
  );
  const activate = () => router.handle(msg({ mentionsSelf: true }));
  return { ...app, a, b, calls, dispatches, router, activate,
    setAskHook: (hook?: () => Promise<void>) => { askHook = hook; } };
}

test("before first tag groups only capture, first registered tag sends just itself", async () => {
  const { router, calls, activate, ctx, db } = setup();
  await router.handle(msg());
  await router.handle(msg({ mentionsSelf: true, senderPhoneE164: "+14155559999" }));
  expect(calls).toHaveLength(0);
  expect(ctx.chatBots.get("test-conn", GROUP)).toBeNull();
  await activate();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.agentResponse).toBe("force_respond");
  expect(calls[0]!.input.query).toBe("[Alice, +14155551111] hello");
  expect(calls[0]!.input.systemInstruction).toContain("reply only to the tagger");
  db.close();
});

test("all subsequent group messages relay with last tagger token, no response wait", async () => {
  const { router, calls, dispatches, activate, a, ctx, db } = setup();
  await activate();
  for (const patch of [
    {},
    { senderPhoneE164: "+14155559999" },
    { senderPhoneE164: "+14155559999", mentionsSelf: true },
    { senderPhoneE164: "+14155550000", fromMe: true, mentionsSelf: true },
  ]) await router.handle(msg(patch));
  expect(calls).toHaveLength(5);
  expect(dispatches).toHaveLength(1);
  for (const call of calls.slice(1)) {
    expect(call.shopperId).toBe(a.id);
    expect(call.input.threadId).toBe("shared-bot");
    expect(call.input.agentResponse).toBe("force_skip");
    expect(call.input.systemInstruction).toBeUndefined();
  }
  expect(ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(a.id);
  db.close();
});

test("two registered shoppers share one bot and each tag uses the tagger despite mapping", async () => {
  const { router, calls, activate, a, b, ctx, db } = setup();
  ctx.mappings.upsert("test-conn", GROUP, a.id);
  await activate();
  await router.handle(msg({ mentionsSelf: true, senderPhoneE164: b.phoneE164 }));
  await router.handle(msg());
  expect(calls[1]!.shopperId).toBe(b.id);
  expect(calls[1]!.input.threadId).toBe("shared-bot");
  expect(calls[2]!.shopperId).toBe(b.id);
  expect(ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(b.id);
  // Mapping must not authorize an unregistered sender to trigger.
  await router.handle(msg({ mentionsSelf: true, senderPhoneE164: "+14155559999" }));
  expect(calls[3]!.input.agentResponse).toBe("force_skip");
  db.close();
});

test("remove and re-add both pause without MCP; next tag continues the same bot", async () => {
  const { router, calls, activate, ctx, db } = setup();
  await activate();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP });
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
  await router.handle(msg());
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP });
  await router.handle(msg({ mentionsSelf: true, senderPhoneE164: "+14155559999" }));
  expect(calls).toHaveLength(1);
  await activate();
  expect(calls[1]!.input.threadId).toBe("shared-bot");
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).toBeNull();
  await router.handle(msg());
  expect(calls[2]!.input.agentResponse).toBe("force_skip");
  db.close();
});

test("self-add without a prior removal pauses existing bot; unknown groups create no state", async () => {
  const { router, calls, activate, ctx, db } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP });
  expect(ctx.chatBots.get("test-conn", GROUP)).toBeNull();
  await activate();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP });
  await router.handle(msg());
  expect(calls).toHaveLength(1);
  db.close();
});

test("membership during first tag cannot be overwritten on MCP acceptance; queued old tags are dropped", async () => {
  const { router, calls, ctx, setAskHook, db } = setup();
  let accept!: () => void;
  setAskHook(() => new Promise<void>((resolve) => { accept = resolve; }));
  const first = router.handle(msg({ mentionsSelf: true }));
  await new Promise((r) => setTimeout(r, 0));
  const queued = router.handle(msg({ mentionsSelf: true }));
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP });
  accept();
  await Promise.all([first, queued]);
  expect(calls).toHaveLength(1);
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
  setAskHook();
  await router.handle(msg());
  expect(calls).toHaveLength(1);
  db.close();
});

test("relay and tag FIFO extends through ask acceptance, not response delivery", async () => {
  const { router, calls, activate, setAskHook, db } = setup();
  await activate();
  let accept!: () => void;
  setAskHook(() => new Promise<void>((resolve) => { accept = resolve; }));
  const relay = router.handle(msg({ text: "first relay" }));
  await new Promise((r) => setTimeout(r, 0));
  const tag = router.handle(msg({ text: "later tag", mentionsSelf: true }));
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(2);
  setAskHook();
  accept();
  await Promise.all([relay, tag]);
  expect(calls.map((c) => c.input.agentResponse)).toEqual(["force_respond", "force_skip", "force_respond"]);
  db.close();
});

test("different chats are not blocked by the router FIFO", async () => {
  const { router, calls, setAskHook, db } = setup();
  let accept!: () => void;
  setAskHook(() => new Promise<void>((resolve) => { accept = resolve; }));
  const first = router.handle(msg({ mentionsSelf: true }));
  await new Promise((r) => setTimeout(r, 0));
  setAskHook();
  await router.handle(msg({ chatJid: "other@g.us", mentionsSelf: true }));
  expect(calls).toHaveLength(2);
  accept();
  await first;
  db.close();
});

test("relay idempotency persists, failed relay is retryable, gateway replies are excluded", async () => {
  const { router, calls, activate, setAskHook, ctx, db } = setup();
  await activate();
  const relay = msg();
  await Promise.all([router.handle(relay), router.handle(relay)]);
  await router.handle(relay);
  expect(calls).toHaveLength(2);
  expect(ctx.outboundLog.claim("test-conn", relay.messageId).status).toBe("already_sent");
  const retry = msg();
  setAskHook(async () => { throw new Error("offline"); });
  await router.handle(retry);
  setAskHook();
  await router.handle(retry);
  expect(calls).toHaveLength(4);
  ctx.outboundLog.recordGatewayMessage("test-conn", GROUP, "gateway-reply");
  await router.handle(msg({ fromMe: true, messageId: "gateway-reply" }));
  expect(calls).toHaveLength(4);
  db.close();
});

test("revoked or disabled last tagger cannot relay; another registered tag can take over", async () => {
  const { router, calls, activate, ctx, a, b, db } = setup();
  await activate();
  ctx.shoppers.setStatus(a.id, "disabled");
  await router.handle(msg({ senderPhoneE164: "+14155559999" }));
  expect(calls).toHaveLength(1);
  await router.handle(msg({ mentionsSelf: true, senderPhoneE164: b.phoneE164 }));
  expect(calls[1]!.shopperId).toBe(b.id);
  db.close();
});

test("DM trigger and manual fromMe behavior stay unchanged", async () => {
  const { router, calls, db } = setup();
  const dm = { isGroup: false, chatJid: "14155551111@s.whatsapp.net" };
  await router.handle(msg(dm));
  await router.handle(msg({ ...dm, fromMe: true }));
  await router.handle(msg({ ...dm, senderPhoneE164: "+14155559999" }));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.agentResponse).toBeUndefined();
  expect(calls[0]!.input.query).toBe("hello @14155550000");
  db.close();
});

test("group media is marker plus caption, no attachment, label fallback never invents a phone", async () => {
  const { router, calls, activate, db } = setup();
  await activate();
  const media = msg({
    msgType: "image", text: "look @123456", mediaStatus: "ready",
    media: { bytes: Buffer.from("test"), mime: "image/jpeg", sizeBytes: 4 },
  });
  await router.handle(media);
  expect(calls[1]!.input.query).toBe("[Alice, +14155551111] [WhatsApp image] look");
  expect(calls[1]!.input.files).toEqual([]);
  expect(media.media).toBeNull();
  const unknown = msg({ senderPhoneE164: null, senderJid: "9876@lid" });
  expect(senderLabel(unknown)).toBe("WhatsApp 9876@lid");
  expect(groupQuery(msg({ text: "@1234" }), "Alice")).toBe("[Alice] [mention]");
  db.close();
});