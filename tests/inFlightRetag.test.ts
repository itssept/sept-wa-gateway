import { expect, test, afterEach } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter, isBareRetag } from "../src/routing/inboundRouter.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";

const apps: any[] = [];
afterEach(() => { for (const a of apps.splice(0)) a.db.close(); });

function setup(inFlightWaitMs?: number) {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  ctx.credentials.setActive(a.id, `shopper-${a.id}`);
  const calls: Array<{ identity: PostingIdentity; input: any; at: number }> = [];
  const dispatches: any[] = [];
  let release: (() => void) | null = null;
  const adapter = { ask: async (identity: PostingIdentity, input: any) => {
    calls.push({ identity, input: structuredClone(input), at: Date.now() });
    return { threadId: "bot-1", threadEventId: `ev-${calls.length}` };
  } };
  const router = new InboundRouter(
    ctx.resolver, adapter as never, ctx.workflows, ctx.chatBots, ctx.outboundLog,
    {
      // First run stays "in flight" until the test releases it.
      dispatch: (input: unknown) => {
        dispatches.push(input);
        if (dispatches.length === 1) return new Promise<void>((r) => { release = r; });
        return Promise.resolve();
      },
      notifyChat: async () => undefined,
    } as never,
    ctx.audit, ctx.log,
    { settings: ctx.gatewaySettings, messages: ctx.messages, getGroup: async () => null,
      prepareHistory: async () => null, relayUnregisteredChats: true, inboundDebounceMs: 0, ...(inFlightWaitMs !== undefined ? { inFlightWaitMs } : {}) },
  );
  const res = { ...app, a, calls, dispatches, router, release: () => release?.() };
  apps.push(res);
  return res;
}

function dm(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectionId: "c", chatJid: "14155551111@s.whatsapp.net",
    senderJid: "14155551111@s.whatsapp.net", senderPhoneE164: "+14155551111",
    messageId: crypto.randomUUID(), ts: Date.now(), text, msgType: "text",
    mediaStatus: "none", media: null, isGroup: false, fromMe: false, mentionsSelf: false, ...extra,
  };
}

test("isBareRetag: mention-only pings carry no ask; real text or media does", () => {
  expect(isBareRetag([dm("@SEPT"), dm("@16503134725 ?"), dm("  @SEPT @SEPT ")])).toBe(true);
  expect(isBareRetag([dm("pls")])).toBe(true);
  expect(isBareRetag([dm("@SEPT invoice this")])).toBe(false);
  expect(isBareRetag([dm("", { msgType: "image", mediaStatus: "ready" })])).toBe(false);
  expect(isBareRetag([])).toBe(false);
});

test("bare re-tag during an in-flight run is relayed force_skip and does not start a new run", async () => {
  const app = setup();
  await app.router.handle(dm("What can you tell me about this"));
  expect(app.calls.at(-1)!.input.agentResponse).toBe("force_respond");
  expect(app.dispatches.length).toBe(1);
  await app.router.handle(dm("@SEPT"));
  await app.router.handle(dm("@SEPT @SEPT"));
  expect(app.calls.slice(1).map((c) => c.input.agentResponse)).toEqual(["force_skip", "force_skip"]);
  expect(app.dispatches.length).toBe(1);
  app.release();
});

test("debounce disabled: a real follow-up is its own trigger and can interrupt the in-flight run", async () => {
  const app = setup();
  await app.router.handle(dm("(image)", { msgType: "text" }));
  await app.router.handle(dm("Invoice this"));
  expect(app.calls.map((c) => c.input.agentResponse)).toEqual(["force_respond", "force_respond"]);
  expect(app.dispatches.length).toBe(2);
  app.release();
});

test("GATEWAY_IN_FLIGHT_WAIT_MS > 0: a real follow-up waits for the in-flight run", async () => {
  const app = setup(2_000);
  await app.router.handle(dm("What can you tell me about this"));
  const follow = app.router.handle(dm("invoice this for Dina 8100 GBP"));
  await new Promise((r) => setTimeout(r, 100));
  expect(app.calls.length).toBe(1); // not submitted yet: would cancel run 1
  app.release();
  await follow;
  expect(app.calls.length).toBe(2);
  expect(app.calls[1]!.input.agentResponse).toBe("force_respond");
  expect(app.dispatches.length).toBe(2);
});

test("the wait is capped so a stuck run cannot block the chat forever", async () => {
  const app = setup(150);
  await app.router.handle(dm("first ask"));
  const t0 = Date.now();
  await app.router.handle(dm("second ask"));
  expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  expect(app.calls[1]!.input.agentResponse).toBe("force_respond");
  app.release();
});

test("no run in flight: a lone @SEPT is still a normal trigger", async () => {
  const app = setup();
  await app.router.handle(dm("@SEPT"));
  expect(app.calls[0]!.input.agentResponse).toBe("force_respond");
});
