import { afterEach, expect, test } from "bun:test";
import { AskSubmissionError } from "../src/promptql/promptqlAdapter.ts";
import { setup as makeSetup, msg, GROUP } from "./routingHelpers.ts";
const apps: ReturnType<typeof makeSetup>[] = [];
function setup() { const app = makeSetup(); apps.push(app); return app; }
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

test("qualifying group mirrors its first shopper and client messages, without activation", async () => {
  const { router, calls, a, ctx, dispatches } = setup();
  await router.handle(msg());
  await router.handle(msg({ senderPhoneE164: "+14155559999", pushName: "Client", text: "question" }));
  expect(calls[0]!.identity).toEqual({ role: "shopper", shopperId: a.id });
  expect(calls[0]!.input.query).toBe("hello @14155550000");
  expect(calls[0]!.input.roomName).toBe("alice-room");
  expect(calls[1]!.identity).toEqual({ role: "client" });
  expect(calls[1]!.input.query).toBe("[Client] Client\n[Phone] +14155559999\n[Message] question");
  expect(calls.every((c) => c.input.agentResponse === "force_skip")).toBe(true);
  expect(dispatches).toHaveLength(0);
  expect(ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(a.id);
});

test("shopper tag uses own SA while inviter owns the bot forever", async () => {
  const { router, calls, a, b, ctx, dispatches } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: b.phoneE164.slice(1) + "@s.whatsapp.net" }, "add");
  await router.handle(msg({ mentionsSelf: true }));
  expect(calls[0]!.identity).toEqual({ role: "shopper", shopperId: a.id });
  expect(calls[0]!.input.roomName).toBe(b.roomName);
  expect(dispatches[0]).toMatchObject({ shopperId: a.id, credentialRole: "shopper", pacingProfile: "default", chatJid: GROUP });
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP }, "remove");
  await router.handle(msg());
  expect(calls).toHaveLength(1);
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: a.phoneE164.slice(1) + "@s.whatsapp.net" }, "add");
  await router.handle(msg({ senderPhoneE164: b.phoneE164, mentionsSelf: true }));
  expect(calls[1]!.identity).toEqual({ role: "shopper", shopperId: b.id });
  expect(calls[1]!.input.threadId).toBe("shared-bot");
  expect(ctx.chatBots.get("test-conn", GROUP)).toMatchObject({ shopperId: b.id, roomName: b.roomName, relayPausedAt: null });
});

test("client tag relays as Client then prompts fixed owner's PA, with PA pacing", async () => {
  const { router, calls, b, dispatches } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: b.phoneE164.slice(1) + "@s.whatsapp.net" }, "add");
  await router.handle(msg({ senderPhoneE164: "+14155559999", mentionsSelf: true }));
  expect(calls.map((c) => c.identity)).toEqual([{ role: "client" }, { role: "pa", shopperId: b.id }]);
  expect(calls[0]!.input.agentResponse).toBe("force_skip");
  expect(calls[1]!.input).toMatchObject({
    agentResponse: "force_respond", threadId: "shared-bot",
    query: "Please respond to the client message above on behalf of Bob.",
  });
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0]).toMatchObject({ credentialRole: "pa", shopperId: b.id, pacingProfile: "pa_reply", chatJid: GROUP });
});

test("shopper tag reacts 👀 on the triggering message once the agent is asked to respond", async () => {
  const { router, reactions, a } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: a.phoneE164.slice(1) + "@s.whatsapp.net" }, "add");
  const triggering = msg({ messageId: "trigger", mentionsSelf: true });
  await router.handle(triggering);
  await router.handle(msg({ messageId: "plain", senderPhoneE164: "+14155559999", pushName: "Client" }));
  expect(reactions).toEqual([{ messageId: "trigger", chatJid: GROUP, emoji: "👀" }]);
});

test("client tag reacts 👀 on the client message, not the synthetic PA prompt", async () => {
  const { router, reactions, b } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: b.phoneE164.slice(1) + "@s.whatsapp.net" }, "add");
  await router.handle(msg({ messageId: "client-msg", senderPhoneE164: "+14155559999", mentionsSelf: true }));
  expect(reactions).toEqual([{ messageId: "client-msg", chatJid: GROUP, emoji: "👀" }]);
});

test("shopper DM reacts 👀; force_skip relays never react", async () => {
  const { router, reactions, a } = setup();
  const dmJid = a.phoneE164.slice(1) + "@s.whatsapp.net";
  await router.handle(msg({ isGroup: false, chatJid: dmJid, messageId: "dm" }));
  await router.handle(msg({ messageId: "group-plain", senderPhoneE164: "+14155559999", pushName: "Client" }));
  expect(reactions).toEqual([{ messageId: "dm", chatJid: dmJid, emoji: "👀" }]);
});

test("non-shopper inviter falls back to earliest enabled registration, not first sender", async () => {
  const { router, ctx, a, b, calls } = setup();
  router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: "14155559999@s.whatsapp.net" }, "add");
  await router.handle(msg({ senderPhoneE164: b.phoneE164 }));
  expect(calls[0]!.identity).toEqual({ role: "shopper", shopperId: b.id });
  expect(ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(a.id);
});

test("unqualified groups route every sender as Client in common room and never trigger", async () => {
  const { router, calls, dispatches, ctx, setGroup } = setup();
  setGroup({ linkedMember: true, participants: [] });
  await router.handle(msg({ mentionsSelf: true }));
  await router.handle(msg({ fromMe: true, mentionsSelf: true }));
  expect(calls.map((c) => c.identity)).toEqual([{ role: "client" }, { role: "client" }]);
  expect(calls.every((c) => c.input.agentResponse === "force_skip")).toBe(true);
  expect(calls[0]!.input.roomName).toBe("common-room");
  expect(ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBeNull();
  expect(dispatches).toHaveLength(0);
});

test("shopper DM always triggers; client DM and linked manual DM never do", async () => {
  const { router, calls, a, dispatches } = setup();
  const dm = { isGroup: false, chatJid: a.phoneE164.slice(1) + "@s.whatsapp.net" };
  await router.handle(msg(dm));
  await router.handle(msg({ ...dm, fromMe: true, mentionsSelf: true }));
  await router.handle(msg({ isGroup: false, chatJid: "14155559999@s.whatsapp.net", senderPhoneE164: "+14155559999", mentionsSelf: true }));
  expect(calls[0]!.input.agentResponse).toBe("force_respond");
  expect(calls[1]!.identity).toEqual({ role: "shopper", shopperId: a.id });
  expect(calls[1]!.input.agentResponse).toBe("force_skip");
  expect(calls[2]!.identity).toEqual({ role: "client" });
  expect(calls[2]!.input).toMatchObject({ roomName: "common-room", agentResponse: "force_skip" });
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].chatJid).toBe(dm.chatJid);
});

test("missing setup drops client traffic safely; shopper traffic continues", async () => {
  const { router, calls, db } = setup();
  db.run("DELETE FROM gateway_settings");
  await router.handle(msg({ senderPhoneE164: "+14155559999" }));
  await router.handle(msg());
  expect(calls).toHaveLength(1);
  expect(db.query("SELECT COUNT(1) AS n FROM audit_log WHERE action = 'inbound.rejected'").get()).toEqual({ n: 1 });
});

test("metadata failure or linked account absence never routes a group", async () => {
  const { router, calls, setGroup } = setup();
  setGroup(null); await router.handle(msg());
  setGroup({ linkedMember: false, participants: [] }); await router.handle(msg());
  expect(calls).toHaveLength(0);
});

test("gateway echoes excluded but manual messages relay using owner", async () => {
  const { router, a, calls, ctx, dispatches } = setup();
  ctx.outboundLog.recordGatewayMessage("test-conn", GROUP, "gateway");
  await router.handle(msg({ messageId: "gateway", fromMe: true }));
  await router.handle(msg({ fromMe: true, mentionsSelf: true }));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.identity).toEqual({ role: "shopper", shopperId: a.id });
  expect(calls[0]!.input.agentResponse).toBe("force_skip");
  expect(dispatches).toHaveLength(0);
});

test("per-chat FIFO awaits submission, deduplicates, and does not wait for replies", async () => {
  const { router, calls, setAskHook } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  setAskHook(async () => { if (calls.length === 1) { entered(); await gate; } });
  const first = msg({ messageId: "same" });
  const p = router.handle(first);
  await started;
  const q = router.handle(msg({ messageId: "second" }));
  expect(calls).toHaveLength(1);
  release(); await Promise.all([p, q]);
  await router.handle(first);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.input.threadId).toBe("shared-bot");
});

test("remove during submission fences queued inputs and persists pause on remembered handle", async () => {
  const { router, calls, setAskHook, ctx, dispatches } = setup();
  setAskHook(async () => { router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP }, "remove"); });
  await router.handle(msg({ mentionsSelf: true }));
  await router.handle(msg());
  expect(calls).toHaveLength(1);
  expect(dispatches).toHaveLength(0);
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
});

test("AskSubmissionError preserves handle, retries encrypted text only once on next input", async () => {
  const { router, calls, setAskHook, ctx, db } = setup();
  setAskHook(async () => { throw new AskSubmissionError("upload_failed", { threadId: "partial-bot", threadEventId: null }); });
  const first = msg({ messageId: "failed", text: "private original", mediaStatus: "ready", media: { bytes: Buffer.from("img"), mime: "image/jpeg", sizeBytes: 3 } });
  await router.handle(first);
  expect(ctx.chatBots.get("test-conn", GROUP)?.threadId).toBe("partial-bot");
  expect(first.media).toBeNull();
  expect(String((db.query("SELECT pending_post_encrypted AS p FROM chat_bot").get() as any).p)).not.toContain("private original");
  setAskHook();
  await router.handle(msg({ text: "next" }));
  expect(calls[1]!.input).toMatchObject({ threadId: "partial-bot", query: "private original", files: [], agentResponse: "force_skip" });
  expect(calls[2]!.input.query).toBe("next");
  expect(ctx.chatBots.pendingPost("test-conn", GROUP)).toBeNull();
  await router.handle(first);
  expect(calls).toHaveLength(3);
});
