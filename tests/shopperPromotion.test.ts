import { afterEach, expect, test } from "bun:test";
import { AskSubmissionError } from "../src/promptql/promptqlAdapter.ts";
import { adminReq } from "./helpers.ts";
import { setup as makeSetup, msg, GROUP } from "./routingHelpers.ts";

const PHONE = "+14155559999";
const PN = "14155559999@s.whatsapp.net";
const apps: ReturnType<typeof makeSetup>[] = [];
function setup() {
  let bots = 0;
  const app = makeSetup(() => `bot-${++bots}`);
  apps.push(app);
  return app;
}
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

async function register(app: ReturnType<typeof setup>, roomName = "new-shopper-room") {
  const response = await adminReq(app.handle, "POST", "/api/v1/shoppers", {
    name: "New shopper", phone: PHONE, roomName,
    mcpToken: "new-shopper-token", paMcpToken: "new-pa-token",
  });
  expect(response.status).toBe(201);
  return app.ctx.shoppers.getByPhone(PHONE)!;
}
function dm(chatJid = PN, overrides: Parameters<typeof msg>[0] = {}) {
  return msg({ isGroup: false, chatJid, senderJid: chatJid, senderPhoneE164: PHONE, ...overrides });
}
function unknownGroup(app: ReturnType<typeof setup>) {
  app.setGroup({ linkedMember: true, participants: [{ jid: PN, phone_e164: PHONE }] });
}

for (const chatJid of [PN, "777123@lid"]) {
  test(`previously unknown DM starts a fresh shopper bot and then reuses it (${chatJid})`, async () => {
    const app = setup();
    const old = dm(chatJid, { messageId: "old", text: "before registration" });
    await app.router.handle(old);
    expect(app.calls[0]!.input).toMatchObject({ roomName: "common-room", agentResponse: "force_skip" });
    expect(app.dispatches).toHaveLength(0);
    const shopper = await register(app);
    expect(app.calls).toHaveLength(1); // Registration itself does not contact WhatsApp or MCP.

    await app.router.handle(old); // A redelivered old message must not create a new bot.
    expect(app.calls).toHaveLength(1);
    await app.router.handle(dm(chatJid, { text: "after registration" }));
    expect(app.calls[1]!).toMatchObject({
      identity: { role: "shopper", shopperId: shopper.id },
      input: { threadId: null, roomName: shopper.roomName, query: "after registration", agentResponse: "force_respond" },
    });
    expect(app.ctx.chatBots.get("test-conn", chatJid)).toMatchObject({
      threadId: "bot-2", shopperId: shopper.id, roomName: shopper.roomName,
    });
    await app.router.handle(dm(chatJid));
    expect(app.calls[2]!.input).toMatchObject({ threadId: "bot-2", roomName: null });
    expect(app.dispatches.map((d) => d.threadId)).toEqual(["bot-2", "bot-2"]);
  });
}

test("registration promotes each previously unqualified chat separately, even when rooms have the same name", async () => {
  const app = setup();
  unknownGroup(app);
  const otherGroup = "120363456@g.us";
  await app.router.handle(dm());
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  await app.router.handle(msg({ chatJid: otherGroup, senderPhoneE164: PHONE }));
  const shopper = await register(app, "common-room");
  await app.router.handle(dm());
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  await app.router.handle(msg({ chatJid: otherGroup, senderPhoneE164: PHONE }));
  expect(app.calls.slice(3).map((c) => c.input.threadId)).toEqual([null, null, null]);
  expect([PN, GROUP, otherGroup].map((jid) => app.ctx.chatBots.get("test-conn", jid)?.threadId))
    .toEqual(["bot-4", "bot-5", "bot-6"]);
  expect([PN, GROUP, otherGroup].every((jid) => app.ctx.chatBots.get("test-conn", jid)?.shopperId === shopper.id)).toBe(true);
});

test("a newly qualified group starts in its owner's room on the next client tag, then uses that owner's PA", async () => {
  const app = setup();
  unknownGroup(app);
  await app.router.handle(msg({ senderPhoneE164: PHONE, mentionsSelf: true }));
  const shopper = await register(app);
  await app.router.handle(msg({ senderPhoneE164: "+14155558888", text: "client question", mentionsSelf: true }));
  expect(app.calls[1]!).toMatchObject({
    identity: { role: "client" },
    input: { threadId: null, roomName: shopper.roomName, agentResponse: "force_skip" },
  });
  expect(app.calls[2]!).toMatchObject({
    identity: { role: "pa", shopperId: shopper.id },
    input: { threadId: "bot-2", roomName: null, agentResponse: "force_respond" },
  });
  expect(app.ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(shopper.id);
  expect(app.dispatches[0]).toMatchObject({ threadId: "bot-2", shopperId: shopper.id, pacingProfile: "pa_reply" });
});

test("promotion selects the registered inviter rather than the next sender", async () => {
  const app = setup();
  unknownGroup(app);
  app.router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: PN }, "add");
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  const shopper = await register(app);
  app.setGroup({ linkedMember: true, participants: [
    { jid: PN, phone_e164: PHONE },
    { jid: "14155551111@s.whatsapp.net", phone_e164: app.a.phoneE164 },
  ] });
  await app.router.handle(msg());
  expect(app.calls[1]!).toMatchObject({
    identity: { role: "shopper", shopperId: app.a.id },
    input: { threadId: null, roomName: shopper.roomName, agentResponse: "force_skip" },
  });
  expect(app.ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(shopper.id);
});

test("promoted groups retain normal shopper triggering and fixed ownership across registration edits and re-add", async () => {
  const app = setup();
  unknownGroup(app);
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  const shopper = await register(app);
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  expect(app.calls[1]!.input).toMatchObject({ threadId: null, roomName: shopper.roomName, agentResponse: "force_skip" });
  await app.router.handle(msg({ senderPhoneE164: PHONE, mentionsSelf: true }));
  expect(app.calls[2]!.input).toMatchObject({ threadId: "bot-2", agentResponse: "force_respond" });

  app.ctx.shoppers.register(shopper.name, PHONE, "edited-room");
  app.router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP }, "remove");
  app.ctx.shoppers.setStatus(shopper.id, "disabled");
  app.setGroup({ linkedMember: true, participants: [{ jid: PN, phone_e164: PHONE }, { jid: "14155551111@s.whatsapp.net", phone_e164: app.a.phoneE164 }] });
  app.router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP, addedByJid: "14155551111@s.whatsapp.net" }, "add");
  await app.router.handle(msg({ mentionsSelf: true }));
  expect(app.calls[3]!.input).toMatchObject({ threadId: "bot-2", roomName: null });
  expect(app.ctx.chatBots.get("test-conn", GROUP)).toMatchObject({
    shopperId: shopper.id, roomName: shopper.roomName, threadId: "bot-2",
  });
});

test("disabled registration or missing membership qualification does not promote common-room bots", async () => {
  const app = setup();
  unknownGroup(app);
  await app.router.handle(dm());
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  const shopper = await register(app);
  app.ctx.shoppers.setStatus(shopper.id, "disabled");
  await app.router.handle(dm());
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  expect(app.calls[2]!.input.threadId).toBe("bot-1");
  expect(app.calls[3]!.input.threadId).toBe("bot-2");
  expect(app.calls.every((c) => c.identity.role === "client")).toBe(true);
  app.ctx.shoppers.setStatus(shopper.id, "enabled");
  app.setGroup({ linkedMember: true, participants: [] });
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  expect(app.calls[4]!.input.threadId).toBe("bot-2");
  app.setGroup({ linkedMember: false, participants: [{ jid: PN, phone_e164: PHONE }] });
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  expect(app.calls).toHaveLength(5);
});

test("linked-phone manual input can promote a DM but never triggers a response", async () => {
  const app = setup();
  await app.router.handle(dm());
  const shopper = await register(app);
  await app.router.handle(dm(PN, { fromMe: true, senderPhoneE164: "+14155550000" }));
  expect(app.calls[1]!).toMatchObject({
    identity: { role: "shopper", shopperId: shopper.id },
    input: { threadId: null, roomName: shopper.roomName, agentResponse: "force_skip" },
  });
  expect(app.dispatches).toHaveLength(0);
});

test("failed new bot creation preserves the common mapping until a handle is returned", async () => {
  const app = setup();
  await app.router.handle(dm());
  const shopper = await register(app);
  app.setAskHook(async () => { throw new Error("MCP unavailable"); });
  await app.router.handle(dm());
  expect(app.ctx.chatBots.get("test-conn", PN)).toMatchObject({
    threadId: "bot-1", shopperId: null, roomName: "common-room",
  });
  app.setAskHook();
  await app.router.handle(dm());
  expect(app.calls[2]!.input).toMatchObject({ threadId: null, roomName: shopper.roomName });
  expect(app.ctx.chatBots.get("test-conn", PN)?.threadId).toBe("bot-2");
});

test("pending pre-registration text stays on the common bot before promotion; failure blocks promotion", async () => {
  const app = setup();
  app.setAskHook(async () => {
    throw new AskSubmissionError("sent_message_failed", { threadId: "common-partial", threadEventId: null });
  });
  await app.router.handle(dm(PN, { messageId: "failed-client", text: "old client text" }));
  const shopper = await register(app);
  await app.router.handle(dm(PN, { text: "not accepted yet" }));
  expect(app.calls[1]!.input).toMatchObject({ threadId: "common-partial", agentResponse: "force_skip" });
  expect(app.ctx.chatBots.get("test-conn", PN)?.shopperId).toBeNull();
  app.setAskHook();
  await app.router.handle(dm(PN, { text: "new shopper text" }));
  expect(app.calls[2]!).toMatchObject({
    identity: { role: "client" }, input: { threadId: "common-partial", files: [], agentResponse: "force_skip" },
  });
  expect(app.calls[3]!).toMatchObject({
    identity: { role: "shopper", shopperId: shopper.id },
    input: { threadId: null, roomName: shopper.roomName, query: "new shopper text" },
  });
  expect(app.ctx.chatBots.pendingPost("test-conn", PN)).toBeNull();
});

test("partial promoted bot creation persists new ownership and retries text without creating another bot", async () => {
  const app = setup();
  await app.router.handle(dm());
  const shopper = await register(app);
  app.setAskHook(async () => {
    throw new AskSubmissionError("upload_failed", { threadId: "shopper-partial", threadEventId: null });
  });
  const failed = dm(PN, {
    messageId: "failed-shopper", text: "new shopper text", mediaStatus: "ready",
    media: { bytes: Buffer.from("img"), mime: "image/jpeg", sizeBytes: 3 },
  });
  await app.router.handle(failed);
  expect(failed.media).toBeNull();
  expect(app.ctx.chatBots.get("test-conn", PN)).toMatchObject({
    shopperId: shopper.id, threadId: "shopper-partial", roomName: shopper.roomName,
  });
  app.setAskHook();
  await app.router.handle(dm());
  expect(app.calls[2]!.input).toMatchObject({ threadId: "shopper-partial", agentResponse: "force_skip", files: [] });
  expect(app.calls[3]!.input.threadId).toBe("shopper-partial");
  expect(app.ctx.chatBots.pendingPost("test-conn", PN)).toBeNull();
  expect(app.dispatches).toHaveLength(1);
});

test("concurrent messages serialize promotion and create only one shopper bot", async () => {
  const app = setup();
  await app.router.handle(dm());
  await register(app);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  app.setAskHook(async () => { if (app.calls.length === 2) { entered(); await gate; } });
  const first = app.router.handle(dm());
  await started;
  const second = app.router.handle(dm());
  expect(app.calls).toHaveLength(2);
  release();
  await Promise.all([first, second]);
  expect(app.calls[1]!.input.threadId).toBeNull();
  expect(app.calls[2]!.input.threadId).toBe("bot-2");
});

test("removal during promotion suppresses replies; re-add resumes the promoted bot", async () => {
  const app = setup();
  unknownGroup(app);
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  const shopper = await register(app);
  app.setAskHook(async () => {
    app.router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP }, "remove");
  });
  await app.router.handle(msg({ senderPhoneE164: PHONE, mentionsSelf: true }));
  expect(app.dispatches).toHaveLength(0);
  expect(app.ctx.chatBots.get("test-conn", GROUP)).toMatchObject({
    shopperId: shopper.id, threadId: "bot-2", roomName: shopper.roomName,
  });
  expect(app.ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
  app.setAskHook();
  app.router.onSelfMembership({ connectionId: "test-conn", groupJid: GROUP }, "add");
  await app.router.handle(msg({ senderPhoneE164: PHONE }));
  expect(app.calls[2]!.input.threadId).toBe("bot-2");
});