import { expect, test } from "bun:test";
import { WhatsAppConnection, type InboundMessage } from "../src/whatsapp/socket.ts";
import { makeTestApp } from "./helpers.ts";
import { GroupMetaStore } from "../src/whatsapp/groupMeta.ts";

const GROUP = "120363123@g.us";
const user = { id: "14155550000:7@s.whatsapp.net", lid: "999123@lid" };
function setup() {
  const app = makeTestApp();
  const inbound: InboundMessage[] = [];
  const events: string[] = [];
  let beforePacedSend: (() => void) | undefined;
  const conn = new WhatsAppConnection(
    app.db, app.ctx.config,
    { enqueue: async (_ctx: unknown, send: () => Promise<string>) => {
      beforePacedSend?.(); return send();
    } } as never,
    app.ctx.messages,
    {
      onInbound: (msg) => { inbound.push(structuredClone(msg)); },
      onSelfRemoved: ({ groupJid }) => { events.push(`remove:${groupJid}`); app.ctx.chatBots.pauseRelay("test-conn", groupJid); },
      onSelfAdded: ({ groupJid }) => { events.push(`add:${groupJid}`); app.ctx.chatBots.pauseRelay("test-conn", groupJid); },
    }, app.ctx.log,
  );
  const sent: string[] = [];
  const sock = {
    user, groupMetadata: async () => ({ id: GROUP, subject: "group", participants: [user] }),
    sendMessage: async (jid: string, _content: unknown, options: { messageId: string }) => {
      expect(app.ctx.outboundLog.isGatewayMessage("test-conn", jid, options.messageId)).toBe(true);
      sent.push(options.messageId);
      // Simulate Baileys echo before sendMessage resolves.
      await (conn as any).onMessagesUpsert({ type: "notify", messages: [{
        key: { remoteJid: jid, id: options.messageId, fromMe: true },
        message: { conversation: "gateway answer" },
      }] }, sock);
      return { key: { id: options.messageId } };
    },
  };
  // Isolate event handlers from network login; the real socket owns these fields.
  (conn as any).live.sock = sock;
  (conn as any).live.status = "linked";
  return { ...app, conn, sock, inbound, events, sent,
    setBeforeSend: (hook: () => void) => { beforePacedSend = hook; } };
}
function message(id: string, fromMe = false, jid = GROUP) {
  return {
    key: { id, remoteJid: jid, fromMe, participant: "14155551111@s.whatsapp.net" },
    message: { extendedTextMessage: { text: "hello @14155550000", contextInfo: { mentionedJid: ["999123@lid"] } } },
  };
}

test("socket captures manual own group messages, routes once, and never triggers itself", async () => {
  const { conn, sock, inbound, db } = setup();
  await (conn as any).onMessagesUpsert({ type: "notify", messages: [message("manual", true)] }, sock);
  await (conn as any).onMessagesUpsert({ type: "append", messages: [message("manual", true)] }, sock);
  await (conn as any).onMessagesUpsert({ type: "notify", messages: [message("dm-own", true, "14155551111@s.whatsapp.net")] }, sock);
  expect(inbound).toHaveLength(1);
  expect(inbound[0]!.mentionsSelf).toBe(false);
  expect(inbound[0]!.senderPhoneE164).toBe("+14155550000");
  expect(db.query("SELECT COUNT(1) AS n FROM whatsapp_message_store").get()).toEqual({ n: 2 });
  db.close();
});

test("socket sets mentionsSelf and group captions do not download media", async () => {
  const { conn, sock, inbound, db } = setup();
  (conn as any).media.download = () => { throw new Error("must not download group files"); };
  await (conn as any).onMessagesUpsert({ type: "notify", messages: [{
    key: { id: "image", remoteJid: GROUP, participant: "123@lid", participantAlt: "14155551111@s.whatsapp.net" },
    message: { imageMessage: { caption: "look @14155550000", contextInfo: { mentionedJid: ["999123@lid"] } } },
  }] }, sock);
  expect(inbound[0]!.mentionsSelf).toBe(true);
  expect(inbound[0]!.senderPhoneE164).toBe("+14155551111");
  expect(inbound[0]!.text).toBe("look @14155550000");
  expect(inbound[0]!.media).toBeNull();
  db.close();
});

test("socket membership hooks pause immediately, remove cached metadata and handle re-add without remove", async () => {
  const { conn, sock, ctx, events, db } = setup();
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: GROUP, shopperId: "shopper", threadId: "bot" });
  const groups = new GroupMetaStore(db, 10000, ctx.log);
  groups.upsert("test-conn", { id: GROUP, subject: "group", owner: undefined, participants: [user] });
  (conn as any).onParticipantUpdate({ id: GROUP, action: "remove", participants: [{ id: "999123@lid" }] }, sock);
  expect(events).toEqual([`remove:${GROUP}`]);
  expect(groups.read("test-conn", GROUP)).toBeNull();
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: GROUP, shopperId: "shopper", threadId: "bot" });
  (conn as any).onGroupUpserts([{ id: GROUP, participants: [user] }], sock);
  expect(events).toEqual([`remove:${GROUP}`, `add:${GROUP}`]);
  expect(ctx.chatBots.get("test-conn", GROUP)?.relayPausedAt).not.toBeNull();
  (conn as any).onParticipantUpdate({ id: GROUP, action: "add", participants: [{ id: "999123@lid" }] }, sock);
  expect(events).toHaveLength(3);
  (conn as any).onParticipantUpdate({ id: GROUP, action: "remove", participants: ["999123@lid"] }, sock);
  expect(events).toHaveLength(3);
  await new Promise((r) => setTimeout(r, 0));
  db.close();
});

test("messages queued before a membership change are captured but not delivered or backfilled", async () => {
  const { conn, sock, inbound, db } = setup();
  const oldEpochs = new Map();
  (conn as any).onSelfMembership(GROUP, "add");
  const up = { type: "notify", messages: [message("old-tag")] };
  await (conn as any).onMessagesUpsert(up, sock, oldEpochs);
  await (conn as any).onMessagesUpsert(up, sock);
  expect(inbound).toHaveLength(0);
  expect(db.query("SELECT COUNT(1) AS n FROM whatsapp_message_store").get()).toEqual({ n: 1 });
  db.close();
});

test("gateway send ID is recorded before an immediate echo and remains identifiable after failure", async () => {
  const { conn, inbound, sent, ctx, sock, db } = setup();
  const options = {
    onMessageId: (id: string) => ctx.outboundLog.recordGatewayMessage("test-conn", GROUP, id),
  };
  await conn.sendText(GROUP, "answer", options);
  expect(sent).toHaveLength(1);
  expect(inbound).toHaveLength(0);
  let uncertainId = "";
  sock.sendMessage = async (_jid, _content, opts) => {
    uncertainId = opts.messageId;
    throw new Error("connection lost after send");
  };
  await expect(conn.sendText(GROUP, "answer", options)).rejects.toThrow();
  expect(ctx.outboundLog.isGatewayMessage("test-conn", GROUP, uncertainId)).toBe(true);
  db.close();
});

test("send guard is checked after anti-ban pacing", async () => {
  const { conn, sent, ctx, setBeforeSend, db } = setup();
  let allowed = true;
  setBeforeSend(() => { allowed = false; });
  await expect(conn.sendText(GROUP, "answer", {
    beforeSend: () => allowed,
    onMessageId: (id) => ctx.outboundLog.recordGatewayMessage("test-conn", GROUP, id),
  })).rejects.toThrow("chat_left");
  expect(sent).toHaveLength(0);
  db.close();
});

test("a metadata fetch started before removal cannot repopulate the removed group", async () => {
  const { db, ctx } = makeTestApp();
  const groups = new GroupMetaStore(db, 10000, ctx.log);
  let finish!: (meta: any) => void;
  const pending = groups.readOrFetch("test-conn", GROUP, {
    groupMetadata: () => new Promise((resolve) => { finish = resolve; }),
  });
  groups.remove("test-conn", GROUP);
  finish({ id: GROUP, subject: "group", participants: [user] });
  await pending;
  expect(groups.read("test-conn", GROUP)).toBeNull();
  db.close();
});