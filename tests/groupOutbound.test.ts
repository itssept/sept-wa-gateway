import { expect, test } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

for (const pacingProfile of [undefined, "default", "pa_reply"] as const) {
  for (const paused of [true, false]) {
    test(`dispatcher (${pacingProfile ?? "omitted"}) ${paused ? "logs chat_left without sending" : "sends normally"} after response wait`, async () => {
      const { ctx, db, logs } = makeTestApp(testConfig({ logLevel: "info" }));
      const group = "123@g.us";
      ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: group, shopperId: "s", threadId: "bot" });
      const workflow = ctx.workflows.create({
        connectionId: "test-conn", chatJid: group, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
      });
      const claim = ctx.outboundLog.claim("test-conn", "input");
      if (claim.status !== "claimed") throw new Error("expected claim");
      const sends: string[] = [];
      const dispatcher = new OutboundDispatcher(
        { waitForResponse: async () => {
          if (paused) ctx.chatBots.pauseRelay("test-conn", group);
          return { status: "completed", message: "answer" };
        } } as never,
        ctx.workflows, ctx.outboundLog,
        { sendText: async (jid: string, _text: string, opts: any) => {
          expect(opts.pacingProfile).toBe(pacingProfile);
          expect(opts.beforeSend()).toBe(true);
          opts.onMessageId("reply");
          sends.push(jid); return "reply";
        } } as never,
        ctx.config, ctx.log, ctx.chatBots,
      );
      await dispatcher.dispatch({
        workflowId: workflow.id, connectionId: "test-conn", chatJid: group,
        shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
        threadId: "bot", threadEventId: null, pacingProfile,
      });
      expect(sends).toEqual(paused ? [] : [group]);
      if (paused) {
        expect(logs.some((log) => log.reason === "chat_left")).toBe(true);
        expect(db.query("SELECT status FROM whatsapp_outbound_log WHERE idempotency_key = 'input'").get())
          .toEqual({ status: "failed" });
      }
      db.close();
    });
  }
}

/** Wire a dispatcher with stubbed adapter + connection, capturing sends. */
function makeArtifactDispatcher(
  ctx: any,
  opts: {
    message: string;
    status?: "completed" | "declined_approval";
    resolve: (threadId: string, refs: unknown) => unknown[] | Promise<unknown[]>;
    onSendText?: (text: string) => string;
    onSendDoc?: (doc: any) => string;
  },
) {
  const texts: string[] = [];
  const docs: Array<{ fileName: string; mimeType: string; caption?: string; size: number; ref: string }> = [];
  const resolveCalls: Array<{ threadId: string; refs: unknown }> = [];
  let docSeq = 0;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({ status: opts.status ?? "completed", message: opts.message }),
      resolveArtifacts: async (_id: unknown, threadId: string, refs: unknown) => {
        resolveCalls.push({ threadId, refs });
        return opts.resolve(threadId, refs);
      },
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, o: any) => {
        const ref = opts.onSendText?.(text) ?? "reply";
        o.onMessageId(ref); texts.push(text); return ref;
      },
      sendDocument: async (_jid: string, doc: any, o: any) => {
        const ref = opts.onSendDoc?.(doc) ?? `doc-${++docSeq}`;
        o.onMessageId(ref);
        docs.push({ fileName: doc.fileName, mimeType: doc.mimeType, caption: doc.caption, size: doc.bytes.length, ref });
        return ref;
      },
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );
  return { dispatcher, texts, docs, resolveCalls };
}

function runDispatch(dispatcher: OutboundDispatcher, ctx: any, chat: string) {
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");
  return dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });
}

test("dispatcher sends the stripped text as the caption on the first artifact document", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, texts, docs, resolveCalls } = makeArtifactDispatcher(ctx, {
    message: 'Here is your report.\n<artifact type="table" identifier="sales" />\nThanks!',
    resolve: () => [
      { ok: true, artifact: { identifier: "sales", title: "Sales", fileName: "artifact-sales.csv", mimeType: "text/csv", bytes: Buffer.from("a,b\n1,2") } },
    ],
  });
  await runDispatch(dispatcher, ctx, chat);

  // No standalone text message: the text rides the first document as a caption.
  expect(texts).toEqual([]);
  expect(resolveCalls).toEqual([{ threadId: "bot", refs: [{ identifier: "sales", type: "table" }] }]);
  expect(docs).toEqual([{
    fileName: "artifact-sales.csv", mimeType: "text/csv",
    caption: "Here is your report.\nThanks!", size: 7, ref: "doc-1",
  }]);
  expect(ctx.outboundLog.isGatewayMessage("test-conn", chat, "doc-1")).toBe(true);
  expect(db.query("SELECT status FROM whatsapp_outbound_log WHERE idempotency_key = 'input'").get())
    .toEqual({ status: "sent" });
  db.close();
});

test("dispatcher captions the first document, sends the rest as follow-up documents", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, docs } = makeArtifactDispatcher(ctx, {
    message: 'Two files.\n<artifact identifier="a"/>\n<artifact identifier="b"/>',
    resolve: () => [
      { ok: true, artifact: { identifier: "a", title: "a", fileName: "a.txt", mimeType: "text/plain", bytes: Buffer.from("aa") } },
      { ok: true, artifact: { identifier: "b", title: "b", fileName: "b.txt", mimeType: "text/plain", bytes: Buffer.from("bbb") } },
    ],
  });
  await runDispatch(dispatcher, ctx, chat);

  expect(docs).toHaveLength(2);
  expect(docs[0]!.caption).toBe("Two files.");
  expect(docs[1]!.caption).toBeUndefined(); // follow-up docs carry no caption
  expect(docs.map((d) => d.fileName)).toEqual(["a.txt", "b.txt"]);
  // Both documents are recorded as gateway echoes.
  expect(ctx.outboundLog.isGatewayMessage("test-conn", chat, "doc-1")).toBe(true);
  expect(ctx.outboundLog.isGatewayMessage("test-conn", chat, "doc-2")).toBe(true);
  db.close();
});

test("dispatcher appends a bracket note and still sends the resolved artifact", async () => {
  const { ctx } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, docs } = makeArtifactDispatcher(ctx, {
    message: 'Report.\n<artifact identifier="ok"/>\n<artifact identifier="big"/>',
    resolve: () => [
      { ok: true, artifact: { identifier: "ok", title: "ok", fileName: "ok.txt", mimeType: "text/plain", bytes: Buffer.from("ok") } },
      { ok: false, identifier: "big", reason: "too_large" },
    ],
  });
  await runDispatch(dispatcher, ctx, chat);

  expect(docs).toHaveLength(1);
  expect(docs[0]!.caption).toBe("Report.\n\n(Attachment too large to send)");
});

test("dispatcher sends a text-only reply with a note when every artifact fails", async () => {
  const { ctx } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, texts, docs } = makeArtifactDispatcher(ctx, {
    message: 'Here is the file.\n<artifact identifier="big"/>',
    resolve: () => [{ ok: false, identifier: "big", reason: "too_large" }],
  });
  await runDispatch(dispatcher, ctx, chat);

  // No document; the text carries the failure note.
  expect(docs).toEqual([]);
  expect(texts).toEqual(["Here is the file.\n\n(Attachment too large to send)"]);
});

test("dispatcher sends just the note when the reply text is empty and the artifact fails", async () => {
  const { ctx } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, texts } = makeArtifactDispatcher(ctx, {
    message: '<artifact identifier="gone"/>',
    resolve: () => [{ ok: false, identifier: "gone", reason: "unavailable" }],
  });
  await runDispatch(dispatcher, ctx, chat);

  expect(texts).toEqual(["(Attachment couldn't be retrieved)"]);
});

test("dispatcher delivers text + files together even if a follow-up document fails", async () => {
  const { ctx, db, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher, docs } = makeArtifactDispatcher(ctx, {
    message: 'Files.\n<artifact identifier="a"/>\n<artifact identifier="b"/>',
    resolve: () => [
      { ok: true, artifact: { identifier: "a", title: "a", fileName: "a.txt", mimeType: "text/plain", bytes: Buffer.from("aa") } },
      { ok: true, artifact: { identifier: "b", title: "b", fileName: "b.txt", mimeType: "text/plain", bytes: Buffer.from("bb") } },
    ],
    onSendDoc: (doc) => { if (doc.fileName === "b.txt") throw new Error("cdn upload failed"); return "doc-1"; },
  });
  await runDispatch(dispatcher, ctx, chat);

  // The captioned first document (the reply) succeeded and is marked sent.
  expect(docs.map((d) => d.fileName)).toEqual(["a.txt"]);
  expect(db.query("SELECT status FROM whatsapp_outbound_log WHERE idempotency_key = 'input'").get())
    .toEqual({ status: "sent" });
  expect(logs.some((l) => l.msg === "artifact send failed")).toBe(true);
  db.close();
});

test("dispatcher fails the reply when the captioned first document cannot be sent", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const { dispatcher } = makeArtifactDispatcher(ctx, {
    message: 'Report.\n<artifact identifier="a"/>',
    resolve: () => [{ ok: true, artifact: { identifier: "a", title: "a", fileName: "a.txt", mimeType: "text/plain", bytes: Buffer.from("aa") } }],
    onSendDoc: () => { throw new Error("cdn upload failed"); },
  });
  await runDispatch(dispatcher, ctx, chat);

  // The first send IS the reply; its failure marks the outbound record failed.
  expect(db.query("SELECT status FROM whatsapp_outbound_log WHERE idempotency_key = 'input'").get())
    .toEqual({ status: "failed" });
  db.close();
});

test("dispatcher does not scan a declined-approval notice for artifacts", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");

  let resolveCalled = false;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "declined_approval",
        message: 'Needs approval <artifact identifier="should-not-fetch" />',
      }),
      resolveArtifacts: async () => { resolveCalled = true; return []; },
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: any) => { opts.onMessageId("reply"); expect(text).toContain("<artifact"); return "reply"; },
      sendDocument: async () => "doc",
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );
  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });
  // A declined-approval message is our own boilerplate: never scanned/fetched.
  expect(resolveCalled).toBe(false);
  db.close();
});
