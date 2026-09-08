import { expect, test } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

for (const paused of [true, false]) {
  test(`dispatcher ${paused ? "logs chat_left without sending" : "sends normally"} after response wait`, async () => {
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
        expect(opts.beforeSend()).toBe(true);
        opts.onMessageId("reply");
        sends.push(jid); return "reply";
      } } as never,
      ctx.config, ctx.log, ctx.chatBots,
    );
    await dispatcher.dispatch({
      workflowId: workflow.id, connectionId: "test-conn", chatJid: group,
      shopperId: "s", idempotencyKey: "input", claimToken: claim.token,
      threadId: "bot", threadEventId: null,
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