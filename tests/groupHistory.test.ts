import { afterEach, expect, test } from "bun:test";
import { proto, type WAMessage } from "baileys";
import { WhatsAppConnection, type HistoryBatchEvent, type SocketHooks } from "../src/whatsapp/socket.ts";
import { loadConfig, resetConfigForTests } from "../src/config.ts";
import { makeTestApp, testConfig } from "./helpers.ts";
import { parseHistoryMessage } from "../src/whatsapp/groupEvents.ts";
import { decryptToString } from "../src/crypto.ts";

const GROUP = "120363123@g.us";
const OTHER = "120363456@g.us";
const user = { id: "14155550000:7@s.whatsapp.net", lid: "999123@lid" };
const open: Array<ReturnType<typeof makeTestApp>> = [];
afterEach(() => { for (const app of open.splice(0)) app.db.close(); resetConfigForTests(); });

function setup(hooks: SocketHooks = {}, enabled = true) {
  const app = makeTestApp(testConfig({ captureGroupHistory: enabled }));
  open.push(app);
  const batches: HistoryBatchEvent[] = [];
  const live: string[] = [];
  const conn = new WhatsAppConnection(app.db, app.ctx.config, {} as never, app.ctx.messages, {
    onInbound: (msg) => { live.push(msg.messageId); },
    onHistoryBatch: (event) => { batches.push(event); },
    ...hooks,
  }, app.ctx.log);
  const sock = { user, groupMetadata: async () => ({ id: GROUP, subject: "Group", participants: [user] }) };
  (conn as any).live.sock = sock;
  const membership = (action: "add" | "remove", groupJid = GROUP) =>
    (conn as any).onParticipantUpdate({ id: groupJid, participants: [{ id: user.lid }], action }, sock);
  const history = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    (conn as any).onHistoryBatch({ chats: [], contacts: [], messages, ...extra }, sock);
  const rows = (groupJid = GROUP) => app.ctx.messages.listUnrelayedHistory("test-conn", groupJid);
  return { ...app, conn, sock, batches, live, membership, history, rows };
}
function message(id: string, ts = 100, groupJid = GROUP): WAMessage {
  return {
    key: { id, remoteJid: groupJid, participant: "123@lid", participantAlt: "14155551111@s.whatsapp.net", fromMe: false },
    messageTimestamp: ts,
    pushName: "Client Name",
    message: { extendedTextMessage: { text: `text ${id}`, contextInfo: { mentionedJid: [user.lid] } } },
  };
}
function image(id: string): WAMessage {
  return { ...message(id), message: { ephemeralMessage: { message: { imageMessage: {
    caption: "a private caption",
    url: "https://example.test/cdn",
    directPath: "/media/path",
    mediaKey: Buffer.alloc(32, 9),
    mimetype: "image/jpeg",
    fileLength: 3,
  } } } } };
}

test("history capture is default-on with strict false opt-out", () => {
  const env = { GATEWAY_ADMIN_TOKEN: "admin-0123456789012345", DATA_ENCRYPTION_KEY: "00".repeat(32) };
  expect(loadConfig(env).captureGroupHistory).toBe(true);
  resetConfigForTests();
  expect(loadConfig({ ...env, WHATSAPP_CAPTURE_GROUP_HISTORY: "false" }).captureGroupHistory).toBe(false);
  resetConfigForTests();
  expect(() => loadConfig({ ...env, WHATSAPP_CAPTURE_GROUP_HISTORY: "0" })).toThrow();
});

test("unregistered-chat relay is default-off with strict true opt-in", () => {
  const env = { GATEWAY_ADMIN_TOKEN: "admin-0123456789012345", DATA_ENCRYPTION_KEY: "00".repeat(32) };
  expect(loadConfig(env).relayUnregisteredChats).toBe(false);
  resetConfigForTests();
  expect(loadConfig({ ...env, RELAY_UNREGISTERED_CHATS: "true" }).relayUnregisteredChats).toBe(true);
  resetConfigForTests();
  expect(() => loadConfig({ ...env, RELAY_UNREGISTERED_CHATS: "1" })).toThrow();
});

test("only self-joined groups are captured, once per group per batch, oldest first", async () => {
  const app = setup();
  await app.history([message("before-join")]);
  expect(app.rows()).toHaveLength(0);
  app.membership("add");
  (app.conn as any).onGroupUpserts([{ id: OTHER, participants: [user] }], app.sock);
  await app.history([
    message("new", 102), message("equal-second-newer", 101),
    message("equal-second-older", 101), message("old", 99),
    message("other", 100, OTHER), message("dm", 100, "14155551111@s.whatsapp.net"),
    message("unjoined", 100, "777@g.us"),
  ]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["old", "equal-second-older", "equal-second-newer", "new"]);
  expect(app.batches).toEqual([
    { connectionId: "test-conn", groupJid: GROUP, count: 4 },
    { connectionId: "test-conn", groupJid: OTHER, count: 1 },
  ]);
  expect(app.live).toEqual([]);
  expect(app.rows()[0]).toMatchObject({ isHistory: true, chatJid: GROUP, senderPhoneE164: "+14155551111" });
});

test("re-add deduplicates all stored IDs, including previously mirrored live and unrelayed history", async () => {
  const app = setup();
  await (app.conn as any).onMessagesUpsert({ type: "notify", messages: [message("live")] }, app.sock);
  app.ctx.messages.markRelayed("test-conn", GROUP, "live");
  app.membership("add");
  await app.history([message("first-history"), message("live")]);
  app.ctx.messages.markRelayed("test-conn", GROUP, "first-history");
  app.membership("remove");
  await app.history([message("while-out")]);
  app.membership("add");
  await app.history([message("gap", 101), message("gap", 101), message("first-history"), message("live")],
    { progress: 50, isLatest: true });
  await app.history([message("older-gap", 99), message("gap", 101)], { progress: 100, isLatest: false });
  expect(app.rows().map((r) => r.messageId)).toEqual(["older-gap", "gap"]);
  expect(app.batches.map((b) => b.count)).toEqual([1, 1, 1]);
  expect(app.live).toEqual(["live"]);
  expect(app.db.query("SELECT is_history FROM whatsapp_message_store WHERE message_id = 'live'").get())
    .toEqual({ is_history: 0 });
  app.ctx.messages.markRelayed("test-conn", GROUP, "gap");
  expect(app.rows().map((r) => r.messageId)).toEqual(["older-gap"]);
});

test("capture-disabled, non-self add, and removed or stale membership do not capture history", async () => {
  const disabled = setup({}, false);
  disabled.membership("add");
  await disabled.history([image("disabled")]);
  expect(disabled.rows()).toEqual([]);
  expect(disabled.batches).toEqual([]);
  const app = setup();
  (app.conn as any).onParticipantUpdate({ id: GROUP, action: "add", participants: [{ id: "someone@lid" }] }, app.sock);
  await app.history([message("not-self")]);
  expect(app.rows()).toEqual([]);
  app.membership("add");
  const epochs = new Map((app.conn as any).groupEpochs);
  app.membership("remove");
  app.membership("add");
  await (app.conn as any).onHistoryBatch({ chats: [], contacts: [], messages: [message("stale")] }, app.sock, epochs);
  expect(app.rows()).toEqual([]);
});

test("invalid event and individual message payloads cannot poison valid history or logs", async () => {
  const app = setup();
  app.membership("add");
  await (app.conn as any).onHistoryBatch({ messages: "bad" }, app.sock);
  await app.history([
    null,
    { ...message("invalid-content"), message: { imageMessage: { caption: 42 } } },
    { ...message("invalid-ts"), messageTimestamp: -1 },
    { ...message("nan-ts"), messageTimestamp: NaN },
    message("valid"),
  ]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["valid"]);
  expect(app.batches).toHaveLength(1);
  expect(JSON.stringify(app.logs)).not.toContain("text valid");
});

test("encrypted history retains wrapped media keys and sender metadata; failure is recorded per row", async () => {
  const app = setup();
  app.membership("add");
  await app.history([image("expired"), message("text")]);
  const row = app.rows().find((r) => r.messageId === "expired")!;
  expect(row.historyMediaStatus).toBe("pending");
  expect(row.historyMessageEncrypted.toString()).not.toContain("a private caption");
  expect(row.historyMessageEncrypted.toString()).not.toContain("/media/path");
  expect(decryptToString(row.historyMessageEncrypted, app.ctx.config.dataEncryptionKey)).toContain("Client Name");
  const downloads: string[] = [];
  (app.conn as any).media.download = async (m: WAMessage) => {
    downloads.push(m.key.id!);
    if (m.key.id === "text") return { status: "none", media: null };
    expect(m.message?.imageMessage?.mediaKey).toEqual(Buffer.alloc(32, 9));
    expect(m.message?.imageMessage?.url).toBe("https://example.test/cdn");
    return { status: "expired", media: null };
  };
  const expired = await app.conn.prepareHistoryMessage(row);
  expect(expired).toMatchObject({ msgType: "image", text: "a private caption", mediaStatus: "expired", media: null, mentionsSelf: false });
  expect(app.rows().find((r) => r.messageId === "expired")?.historyMediaStatus).toBe("expired");
  const text = await app.conn.prepareHistoryMessage(app.rows().find((r) => r.messageId === "text")!);
  expect(text?.mentionsSelf).toBe(false);
  expect(downloads).toEqual(["expired", "text"]);
  expect(app.live).toEqual([]);
});

test("media download exceptions and oversize results leave other rows replayable", async () => {
  const app = setup();
  app.membership("add");
  await app.history([image("throws"), image("large")]);
  (app.conn as any).media.download = async (m: WAMessage) => {
    if (m.key.id === "throws") throw new Error("not downloadable");
    return { status: "too_large", media: null };
  };
  for (const row of app.rows()) await app.conn.prepareHistoryMessage(row);
  expect(app.rows().map((r) => r.historyMediaStatus)).toEqual(["too_large", "failed"]);
});

test("protobuf Long timestamps survive encrypted persistence and replay", async () => {
  const app = setup();
  app.membership("add");
  const wire = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(message("long", 1777777777)).finish());
  expect(typeof wire.messageTimestamp).toBe("object");
  expect(parseHistoryMessage(wire)).not.toBeNull();
  await app.history([wire]);
  expect(app.rows()[0]?.ts).toBe(1777777777000);
  expect((await app.conn.prepareHistoryMessage(app.rows()[0]!))?.ts).toBe(1777777777000);
});

test("gateway replies are retained but excluded from replay; own manual history is relay-only", async () => {
  const app = setup();
  app.ctx.outboundLog.recordGatewayMessage("test-conn", GROUP, "gateway");
  app.membership("add");
  await app.history([
    { ...message("gateway"), key: { ...message("gateway").key, fromMe: true } },
    { ...message("manual"), key: { ...message("manual").key, fromMe: true } },
  ]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["manual"]);
  expect((await app.conn.prepareHistoryMessage(app.rows()[0]!))?.mentionsSelf).toBe(false);
});

test("queued history callback is awaited; callback failure does not lose captured rows", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const app = setup({ onHistoryBatch: async () => {
    order.push("history"); entered(); await gate; order.push("finished"); throw new Error("replay failed");
  } });
  app.membership("add");
  (app.conn as any).queueHistoryBatch({ chats: [], contacts: [], messages: [message("captured")] }, app.sock);
  // Same queue used by the registered messages.upsert listener.
  (app.conn as any).inboundQueue = (app.conn as any).inboundQueue.then(() => { order.push("live"); });
  await started;
  expect(order).toEqual(["history"]);
  release();
  await (app.conn as any).inboundQueue;
  expect(order).toEqual(["history", "finished", "live"]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["captured"]);
});

test("no-content history stubs are retained rather than dropping a whole batch", async () => {
  const app = setup();
  app.membership("add");
  await app.history([{ ...message("stub"), message: null, messageStubType: 27 }, message("content")]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["content", "stub"]);
});

test("a group removed while another group's callback runs is not captured", async () => {
  const app = setup({ onHistoryBatch: ({ groupJid }) => {
    if (groupJid === GROUP) app.membership("remove", OTHER);
  } });
  app.membership("add");
  app.membership("add", OTHER);
  await app.history([message("first"), message("removed", 100, OTHER)]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["first"]);
  expect(app.rows(OTHER)).toEqual([]);
});

test("chunkOrder without progress keeps capture open for later chunks", async () => {
  const app = setup();
  app.membership("add");
  await app.history([message("chunk-0", 101)], { chunkOrder: 0, isLatest: true });
  await app.history([message("chunk-1", 100)], { chunkOrder: 1, progress: 100 });
  await app.history([message("unrelated-later", 99)]);
  expect(app.rows().map((r) => r.messageId)).toEqual(["chunk-1", "chunk-0"]);
});
