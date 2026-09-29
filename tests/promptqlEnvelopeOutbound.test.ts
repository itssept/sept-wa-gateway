import { expect, test } from "bun:test";
import { makeTestApp, testConfig } from "./helpers.ts";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";

/** Exact WhatsApp text from the 2026-09-29 Yara smoke on sha-c5df721. */
const LIVE_ENVELOPE =
  '{"artifacts":[],"status":"completed","project_name":"p-217696ea-9cb2","warnings":[],"approvals":[]}';

test("P0: empty-artifacts completed PromptQL envelope is never sent to WhatsApp", async () => {
  const { ctx, db, logs } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input");
  if (claim.status !== "claimed") throw new Error("expected claim");

  let sent: string | null = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: LIVE_ENVELOPE,
        artifacts: [],
      }),
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string) => {
        sent = text;
        return "reply";
      },
      sendDocument: async () => {
        throw new Error("should not send document");
      },
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sent).toBeNull();
  expect(logs.some((l) => l.reason === "promptql_envelope")).toBe(true);
  const dumped = JSON.stringify(logs);
  expect(dumped).not.toContain(LIVE_ENVELOPE);
  expect(dumped).not.toContain("p-217696ea-9cb2");
  db.close();
});

test("P0: empty completed message with no artifacts fails silently (no WA send)", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const chat = "shopper@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "input2", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "input2");
  if (claim.status !== "claimed") throw new Error("expected claim");

  let sent: string | null = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: "",
        artifacts: [],
      }),
    } as never,
    ctx.workflows, ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string) => {
        sent = text;
        return "reply";
      },
    } as never,
    ctx.config, ctx.log, ctx.chatBots,
  );

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "input2", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sent).toBeNull();
  db.close();
});
