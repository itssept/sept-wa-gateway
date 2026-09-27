import { expect, test } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { parseArtifactRefs } from "../src/promptql/promptqlAdapter.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

test("regression gw-01: promptql file artifact <artifact type='file' identifier='...' /> is intercepted and sent as native document attachment", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const rawBotResponse = `Here is the commercial invoice for your deal.\n<artifact type="file" identifier="sept_invoice_deal_8841" />\nKindly let me know once reviewed.`;

  // 1. Verify tag parsing & stripping
  const { text: stripped, refs } = parseArtifactRefs(rawBotResponse);
  expect(refs).toEqual([{ identifier: "sept_invoice_deal_8841", type: "file" }]);
  expect(stripped).not.toContain("<artifact");
  expect(stripped).not.toContain("sept_invoice_deal_8841");
  expect(stripped).toBe("Here is the commercial invoice for your deal.\nKindly let me know once reviewed.");

  // 2. Mock adapter & connection
  let sentDoc: any = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: rawBotResponse,
        artifacts: [
          {
            identifier: "sept_invoice_deal_8841",
            title: "Commercial Invoice SEPT-INV-2026-8841.pdf",
            artifact_type: "file",
            artifact_reference: { artifact_id: "art-uuid-8841", version: 0 },
          },
        ],
      }),
      resolveArtifacts: async (_identity: any, _respArts: any[], resolvedRefs: any[]) => {
        expect(resolvedRefs).toEqual([{ identifier: "sept_invoice_deal_8841", type: "file" }]);
        return [{
          ok: true,
          artifact: {
            identifier: "sept_invoice_deal_8841",
            title: "Commercial Invoice SEPT-INV-2026-8841.pdf",
            fileName: "SEPT-INV-2026-8841.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("%PDF-1.4 test invoice data"),
          },
        }];
      },
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async () => { throw new Error("Should not send plain text when artifact present"); },
      sendDocument: async (_jid: string, doc: any, opts: any) => {
        opts.onMessageId("doc-msg-1");
        sentDoc = doc;
        return "doc-msg-1";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );

  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "inbound-inv-1", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "inbound-inv-1");
  if (claim.status !== "claimed") throw new Error("expected claim");

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "inbound-inv-1", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  // 3. Assertions matching Acceptance Criteria
  expect(sentDoc).not.toBeNull();
  expect(sentDoc.fileName).toBe("SEPT-INV-2026-8841.pdf");
  expect(sentDoc.mimeType).toBe("application/pdf");
  expect(sentDoc.bytes.toString()).toBe("%PDF-1.4 test invoice data");
  expect(sentDoc.caption).toBe("Here is the commercial invoice for your deal.\nKindly let me know once reviewed.");
  expect(sentDoc.caption).not.toContain("<artifact");
  expect(sentDoc.caption).not.toContain("https://ql.app/l/");

  // Verify status in outbound log
  expect(db.query("SELECT status FROM whatsapp_outbound_log WHERE idempotency_key = 'inbound-inv-1'").get())
    .toEqual({ status: "sent" });

  db.close();
});

test("regression gw-01: download failure produces 'failed to send' notice and never silently drops", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const rawBotResponse = `Here is your requested invoice.\n<artifact type="file" identifier="corrupted_invoice" />`;

  let sentText: string | null = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: rawBotResponse,
        artifacts: [
          {
            identifier: "corrupted_invoice",
            title: "Corrupted Invoice",
            artifact_type: "file",
            artifact_reference: { artifact_id: "art-uuid-bad", version: 0 },
          },
        ],
      }),
      resolveArtifacts: async () => {
        return [{
          ok: false,
          identifier: "corrupted_invoice",
          reason: "unavailable" as const,
        }];
      },
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: any) => {
        opts.onMessageId("text-fail-msg-1");
        sentText = text;
        return "text-fail-msg-1";
      },
      sendDocument: async () => { throw new Error("Should not send document on resolution failure"); },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );

  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "inbound-inv-2", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "inbound-inv-2");
  if (claim.status !== "claimed") throw new Error("expected claim");

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "inbound-inv-2", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sentText).not.toBeNull();
  expect(sentText).toContain("Here is your requested invoice.");
  expect(sentText).toContain("(Attachment couldn't be retrieved)");
  expect(sentText).not.toContain("<artifact");

  db.close();
});
