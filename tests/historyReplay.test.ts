import { afterEach, expect, test } from "bun:test";
import { type WAMessage } from "baileys";
import { WhatsAppConnection } from "../src/whatsapp/socket.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { AskSubmissionError, type PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import { makeTestApp, testConfig } from "./helpers.ts";
import { loadConfig, resetConfigForTests } from "../src/config.ts";
const GROUP = "120363123@g.us";
const user = { id: "14155550000:7@s.whatsapp.net", lid: "999123@lid" };
const apps: Array<{ db: ReturnType<typeof makeTestApp>["db"]; conn: WhatsAppConnection }> = [];
afterEach(() => {
  for (const { db, conn } of apps.splice(0)) {
    for (const wait of (conn as any).joinWaits.values()) clearTimeout(wait.timer);
    db.close();
  }
  resetConfigForTests();
});
function setup(wait = 1000) {
  const app = makeTestApp(testConfig({ historyJoinWaitMs: wait }));
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common");
  const owner = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  let router!: InboundRouter;
  const conn = new WhatsAppConnection(app.db, ctx.config, {} as never, ctx.messages, {
    onInbound: (msg) => router.handle(msg),
    onHistoryBatch: (event) => router.onHistoryBatch(event),
    onSelfAdded: (event) => router.onSelfMembership(event, "add"),
    onSelfRemoved: (event) => router.onSelfMembership(event, "remove"),
  }, ctx.log);
  const sock = { user, groupMetadata: async () => ({
    id: GROUP, subject: "Group", participants: [
      { id: user.lid, phoneNumber: user.id },
      { id: "14155551111@s.whatsapp.net" },
    ],
  }) };
  (conn as any).live.sock = sock;
  (conn as any).media.download = async () => ({ status: "none", media: null });
  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  const dispatches: unknown[] = [];
  let failQuery: string | null = null;
  router = new InboundRouter(ctx.resolver, { ask: async (identity: PostingIdentity, input: any) => {
    calls.push({ identity, input: structuredClone(input) });
    if (input.query === failQuery) throw new AskSubmissionError("sent_message_failed", { threadId: "bot", threadEventId: null });
    return { threadId: input.threadId ?? "bot", threadEventId: "event" };
  } } as never, ctx.workflows, ctx.chatBots, ctx.outboundLog,
  { dispatch: async (v: unknown) => { dispatches.push(v); } } as never, ctx.audit, ctx.log, {
    settings: ctx.gatewaySettings, messages: ctx.messages,
    getGroup: (jid) => conn.routingGroup(jid),
    prepareHistory: (row) => conn.prepareHistoryMessage(row),
  });
  apps.push({ db: app.db, conn });
  const membership = (action: "add" | "remove") => (conn as any).onParticipantUpdate({
    id: GROUP, participants: [{ id: user.lid }], action,
    author: "14155551111@s.whatsapp.net",
  }, sock);
  const history = async (messages: WAMessage[], extra: Record<string, unknown> = {}) => {
    (conn as any).queueHistoryBatch({ chats: [], contacts: [], messages, ...extra }, sock);
    await (conn as any).inboundQueue;
  };
  const live = async (...messages: WAMessage[]) => {
    const epochs = new Map((conn as any).groupEpochs);
    (conn as any).inboundQueue = (conn as any).inboundQueue.then(() => (conn as any).onMessagesUpsert({ messages, type: "notify" }, sock, epochs));
    await (conn as any).inboundQueue;
  };
  return { ...app, conn, router, sock, owner, calls, dispatches, history, live, membership,
    fail: (query: string | null) => { failQuery = query; } };
}
function message(id: string, ts: number, client = false): WAMessage {
  return {
    key: { id, remoteJid: GROUP, participant: client ? "123@lid" : "14155551111@s.whatsapp.net" },
    messageTimestamp: ts, pushName: client ? "Priya" : "Alice",
    message: { extendedTextMessage: { text: id, contextInfo: { mentionedJid: [user.lid] } } },
  };
}

test("join wait environment defaults to 5 seconds and rejects invalid or unbounded waits", () => {
  const env = { GATEWAY_ADMIN_TOKEN: "admin-0123456789012345", DATA_ENCRYPTION_KEY: "00".repeat(32) };
  expect(loadConfig(env).historyJoinWaitMs).toBe(5000);
  for (const raw of ["-1", "60001", "2.5", "bad"]) {
    resetConfigForTests();
    expect(() => loadConfig({ ...env, WHATSAPP_HISTORY_JOIN_WAIT_MS: raw })).toThrow();
  }
  resetConfigForTests();
  expect(loadConfig({ ...env, WHATSAPP_HISTORY_JOIN_WAIT_MS: "0" }).historyJoinWaitMs).toBe(0);
});

test("first live arrival waits for all chunks, global oldest-first replay then live trigger", async () => {
  const app = setup();
  app.membership("add");
  await app.live(message("live", 110));
  expect(app.calls).toHaveLength(0);
  await app.history([message("newer", 103, true)], { progress: 50, chunkOrder: 0 });
  expect(app.calls).toHaveLength(0);
  await app.history([message("older", 100)], { progress: 100, chunkOrder: 1 });
  expect(app.calls.map((c) => c.input.query)).toEqual([
    "Replaying 2 messages from group history, oldest first", "older",
    "[Client] Priya\nnewer", "End of history", "live",
  ]);
  expect(app.calls.slice(0, 4).every((c) => c.input.agentResponse === "force_skip")).toBe(true);
  expect(app.calls.map((c) => c.identity)).toEqual([
    { role: "client" }, { role: "shopper", shopperId: app.owner.id },
    { role: "client" }, { role: "client" }, { role: "shopper", shopperId: app.owner.id },
  ]);
  expect(app.calls[0]!.input.roomName).toBe("alice-room");
  expect(app.calls.slice(1).every((c) => c.input.threadId === "bot")).toBe(true);
  expect(app.dispatches).toHaveLength(1);
  expect(app.ctx.messages.listUnrelayedHistory("test-conn", GROUP)).toEqual([]);
  expect(app.ctx.chatBots.get("test-conn", GROUP)?.shopperId).toBe(app.owner.id);
});

test("timeout releases live; late history reuses bot and precedes subsequent live messages", async () => {
  const app = setup(10);
  app.membership("add");
  await app.live(message("first-live", 110));
  await new Promise((r) => setTimeout(r, 30));
  await (app.conn as any).inboundQueue;
  expect(app.calls.map((c) => c.input.query)).toEqual(["first-live"]);
  const history = app.history([message("late-history", 100)]);
  const live = app.live(message("second-live", 111));
  await Promise.all([history, live]);
  expect(app.calls.map((c) => c.input.query)).toEqual([
    "first-live", "Replaying 1 messages from group history, oldest first",
    "late-history", "End of history", "second-live",
  ]);
  expect(app.calls.slice(1).every((c) => c.input.threadId === "bot")).toBe(true);
  expect(app.dispatches).toHaveLength(2);
});

test("partial rows replay at timeout and remaining chunks replay before further live", async () => {
  const app = setup(10);
  app.membership("add");
  await app.history([message("part", 100)], { progress: 50 });
  await app.live(message("live", 110));
  await new Promise((r) => setTimeout(r, 30));
  await (app.conn as any).inboundQueue;
  expect(app.calls.map((c) => c.input.query)).toEqual([
    "Replaying 1 messages from group history, oldest first", "part", "End of history", "live",
  ]);
  await app.history([message("rest", 101)], { progress: 100 });
  expect(app.calls.slice(4).map((c) => c.input.query)).toEqual([
    "Replaying 1 messages from group history, oldest first", "rest", "End of history",
  ]);
});

test("empty complete history makes no bot or brackets and immediately releases buffered live", async () => {
  const app = setup();
  app.membership("add");
  await app.history([], { progress: 100 });
  expect(app.calls).toHaveLength(0);
  app.membership("remove"); app.membership("add");
  await app.live(message("live", 110));
  await app.history([], { progress: 100 });
  expect(app.calls.map((c) => c.input.query)).toEqual(["live"]);
  expect((app.conn as any).joinWaits.size).toBe(0);
});

test("history per-row failure continues, keeps only failed row unrelayed, and retries on later batch", async () => {
  const app = setup(0);
  app.membership("add");
  app.fail("bad");
  await app.history([message("good", 101), message("bad", 100)]);
  expect(app.calls.map((c) => c.input.query)).toEqual([
    "Replaying 2 messages from group history, oldest first", "bad", "good", "End of history",
  ]);
  expect(app.ctx.messages.listUnrelayedHistory("test-conn", GROUP).map((r) => r.messageId)).toEqual(["bad"]);
  expect(app.ctx.chatBots.pendingPost("test-conn", GROUP)).toBeNull();
  expect(app.dispatches).toHaveLength(0);
  app.fail(null);
  await app.router.onHistoryBatch({ connectionId: "test-conn", groupJid: GROUP, count: 0 });
  expect(app.ctx.messages.listUnrelayedHistory("test-conn", GROUP)).toEqual([]);
});

test("history files use same helper and parser metadata survives expired downloads", async () => {
  const app = setup(0);
  app.membership("add");
  const doc = (id: string) => ({
    ...message(id, 100, true), message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "invoice.pdf", mimetype: "application/pdf" } } } },
  });
  (app.conn as any).media.download = async (m: WAMessage) => m.key.id === "expired"
    ? { status: "expired", media: null }
    : { status: "ready", media: { bytes: Buffer.from("doc"), fileName: "invoice.pdf", mime: "application/pdf", sizeBytes: 3 } };
  await app.history([doc("expired"), doc("ready")]);
  const posts = app.calls.slice(1, 3);
  expect(posts.every((c) => c.input.query === "[Client] Priya\n(document: invoice.pdf)")).toBe(true);
  expect(posts[0]!.input.files).toEqual([{ file_name: "invoice.pdf", mime_type: "application/pdf", content_base64: "ZG9j" }]);
  expect(posts[1]!.input.files).toEqual([]);
  expect(app.dispatches).toHaveLength(0);
});

test("duplicate add fills inviter without losing buffered live, remove drops old wait", async () => {
  const app = setup();
  (app.conn as any).onGroupUpserts([{ id: GROUP, participants: [{ id: user.lid }] }], app.sock);
  await app.live(message("live", 110));
  app.membership("add");
  await app.history([message("old", 100)]);
  expect(app.calls.at(-1)!.input.query).toBe("live");
  app.membership("remove"); app.membership("add");
  await app.live(message("stale", 120));
  app.membership("remove"); app.membership("add");
  await app.history([]);
  expect(app.calls.some((c) => c.input.query === "stale")).toBe(false);
});

test("replay never triggers even for client tags and does nothing when Client setup is missing", async () => {
  const app = setup(0);
  app.membership("add");
  app.db.run("DELETE FROM gateway_settings");
  await app.history([message("client", 100, true)]);
  expect(app.calls).toEqual([]);
  expect(app.ctx.messages.listUnrelayedHistory("test-conn", GROUP)).toHaveLength(1);
  app.ctx.gatewaySettings.set("client-token", "common");
  await app.router.onHistoryBatch({ connectionId: "test-conn", groupJid: GROUP, count: 0 });
  expect(app.calls).toHaveLength(3);
  expect(app.calls.every((c) => c.identity.role === "client" && c.input.agentResponse === "force_skip")).toBe(true);
  expect(app.dispatches).toEqual([]);
});
