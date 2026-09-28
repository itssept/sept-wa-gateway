import { expect, test } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

const BANNER = `⚠️ SEPT's run was cancelled before it could finish.

https://ql.app/l/AbCdEf12
https://prompt.ql.app/project/p-1/thread/b44a88d0-ab94-47b2-ae19-d9eceab9e7c6
run id: 3f2a1111-2222-4333-8444-555566667777`;

test("a completed cancel banner is not sent to WhatsApp", async () => {
  const { ctx, db, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");

  let resolveCalled = false;
  const sends: string[] = [];
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: BANNER,
        artifacts: [{
          identifier: "invoice-json",
          title: "invoice",
          artifact_type: "file",
          artifact_reference: { artifact_id: "art-1", version: 0 },
        }],
      }),
      resolveArtifacts: async () => { resolveCalled = true; return []; },
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string) => { sends.push(text); return "reply"; },
      sendDocument: async (_jid: string, doc: { caption?: string }) => {
        sends.push(doc.caption ?? "");
        return "doc";
      },
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sends).toEqual([]);
  expect(resolveCalled).toBe(false);
  expect(logs.some((l) => l.reason === "lifecycle_notice")).toBe(true);
  const dumped = JSON.stringify(logs);
  expect(dumped).not.toContain("ql.app");
  expect(dumped).not.toContain("cancelled before");
  expect(dumped).not.toContain("3f2a1111");
  db.close();
});

test("a failed wait does not forward the server cancel notice", async () => {
  const { ctx, db, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");

  const sends: string[] = [];
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "failed",
        message: `${BANNER}\ninterrupted_due_to_new_trigger`,
      }),
    } as never,
    ctx.workflows, ctx.outboundLog,
    { sendText: async (_jid: string, text: string) => { sends.push(text); return "reply"; } } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sends).toEqual([]);
  expect(logs.some((l) => l.reason === "interrupted_due_to_new_trigger")).toBe(true);
  const dumped = JSON.stringify(logs);
  expect(dumped).not.toContain("ql.app");
  expect(dumped).not.toContain("SEPT");
  db.close();
});

test("concierge text is sent with the cancel banner and permalinks removed", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");

  let sent = "";
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: `Invoice is ready for Noor.\n\n${BANNER}\n\nTotal $5,000.`,
        artifacts: [],
      }),
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("reply");
        sent = text;
        return "reply";
      },
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sent).toContain("Invoice is ready for Noor.");
  expect(sent).toContain("Total $5,000.");
  expect(sent).not.toContain("ql.app");
  expect(sent).not.toContain("cancelled before");
  expect(sent).not.toContain("3f2a1111");
  expect(sent).not.toContain("prompt.ql.app");
  db.close();
});
