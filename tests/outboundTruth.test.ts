import { expect, test } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { isUnperformableAdminClaim, stripUnperformableAdminClaims } from "../src/routing/outboundTruth.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

test("admin-claim matcher stays narrow", () => {
  expect(isUnperformableAdminClaim("Setting all background approvals to auto-approve")).toBe(true);
  expect(isUnperformableAdminClaim("I've set all background approvals to auto-approve.")).toBe(true);
  expect(isUnperformableAdminClaim("I updated the PromptQL approval settings.")).toBe(true);
  expect(isUnperformableAdminClaim("I changed platform permission settings.")).toBe(true);
  expect(isUnperformableAdminClaim("I disabled the approval gate.")).toBe(true);
  expect(isUnperformableAdminClaim("All background approvals are now enabled.")).toBe(true);
  expect(isUnperformableAdminClaim("Background permissions have been granted.")).toBe(true);

  expect(isUnperformableAdminClaim(
    "This request needs approval for a sensitive action.",
  )).toBe(false);
  expect(isUnperformableAdminClaim(
    "It was not auto-approved — please review it in the workspace.",
  )).toBe(false);
  expect(isUnperformableAdminClaim("Draft messages in your voice, for your approval")).toBe(false);
  expect(isUnperformableAdminClaim("Draft ready for your approval.")).toBe(false);
  expect(isUnperformableAdminClaim("I cannot change approval settings from this chat.")).toBe(false);
  expect(isUnperformableAdminClaim("The client approved the invoice.")).toBe(false);
  expect(isUnperformableAdminClaim("Payment of GBP 8100 was approved by the client.")).toBe(false);
  expect(isUnperformableAdminClaim("Background approvals remain manual.")).toBe(false);
  expect(isUnperformableAdminClaim("The Kelly 28 is available in gold.")).toBe(false);
});

test("a mixed reply keeps the status sentence", () => {
  expect(stripUnperformableAdminClaims(
    "The Kelly 28 is available in gold. Setting all background approvals to auto-approve.",
  )).toBe("The Kelly 28 is available in gold.");
});

test("a false auto-approve claim is not sent on WhatsApp", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const sent: { text?: string; doc?: unknown } = {};
  const dispatcher = new OutboundDispatcher(
    { waitForResponse: async () => ({
      status: "completed" as const,
      message: "Setting all background approvals to auto-approve",
      artifacts: [],
    }) } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string) => {
        sent.text = text;
        return "text-1";
      },
      sendDocument: async () => {
        sent.doc = true;
        return "doc-1";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "claim-1", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "claim-1");
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: "claim-1",
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
  });
  expect(sent.text).toBeUndefined();
  expect(sent.doc).toBeUndefined();
  db.close();
});

test("a status line survives next to a false settings claim", async () => {
  const { ctx, db } = makeTestApp(testConfig());
  const sent: { text?: string } = {};
  const dispatcher = new OutboundDispatcher(
    { waitForResponse: async () => ({
      status: "completed" as const,
      message: "The Kelly 28 is available in gold.\n\nI've updated the PromptQL approval settings so voice notes auto-approve.",
      artifacts: [],
    }) } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("text-1");
        sent.text = text;
        return "text-1";
      },
      sendDocument: async () => "doc-1",
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "claim-2", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "claim-2");
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: "claim-2",
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
  });
  expect(sent.text).toBe("The Kelly 28 is available in gold.");
  expect(sent.text).not.toMatch(/auto-approve/i);
  expect(sent.text).not.toMatch(/approval settings/i);
  db.close();
});
