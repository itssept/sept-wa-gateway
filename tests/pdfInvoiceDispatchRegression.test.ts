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

  let sentText: any = null;
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

test("regression gw-01b: invoice json+markdown sidecars are NOT attached; PDF is preferred", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  // Live failure mode (2026-09-28 ~07:02 Rome): PromptQL replaced tags with permalinks
  // and listed invoice_* json + md artifacts. Gateway must not sendDocument those.
  const rawBotResponse = `Invoice ready for Dina.\nhttps://ql.app/l/abc123\n\nPlease confirm once paid.`;

  const sentDocs: any[] = [];
  let sentText: any = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: rawBotResponse,
        artifacts: [
          {
            identifier: "invoice_dina_me_dolly",
            title: "invoice_dina_me_dolly",
            artifact_type: "json",
            artifact_reference: { artifact_id: "art-json", version: 0 },
          },
          {
            identifier: "invoice_dina_me_dolly_md",
            title: "invoice_dina_me_dolly.md",
            artifact_type: "markdown",
            artifact_reference: { artifact_id: "art-md", version: 0 },
          },
          {
            identifier: "sept_invoice_dina_me_dolly",
            title: "SEPT-INV-2026-DINA.pdf",
            artifact_type: "file",
            artifact_reference: { artifact_id: "art-pdf", version: 0 },
          },
        ],
      }),
      resolveArtifacts: async (_identity: any, _respArts: any[], resolvedRefs: any[]) => {
        // Must not request json/md sidecars.
        expect(resolvedRefs.every((r: any) => !/json|markdown|md/i.test(r.type ?? ""))).toBe(true);
        expect(resolvedRefs.some((r: any) => r.identifier === "sept_invoice_dina_me_dolly")).toBe(true);
        return resolvedRefs.map((r: any) => ({
          ok: true as const,
          artifact: {
            identifier: r.identifier,
            title: "SEPT-INV-2026-DINA.pdf",
            fileName: "SEPT-INV-2026-DINA.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("%PDF-1.4 dina invoice"),
          },
        }));
      },
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: any) => {
        opts.onMessageId("text-1");
        sentText = text;
        return "text-1";
      },
      sendDocument: async (_jid: string, doc: any, opts: any) => {
        opts.onMessageId(`doc-${sentDocs.length}`);
        sentDocs.push(doc);
        return `doc-${sentDocs.length}`;
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );

  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "inbound-inv-3", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "inbound-inv-3");
  if (claim.status !== "claimed") throw new Error("expected claim");

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "inbound-inv-3", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sentDocs.length).toBe(1);
  expect(sentDocs[0].mimeType).toBe("application/pdf");
  expect(sentDocs[0].fileName).toBe("SEPT-INV-2026-DINA.pdf");
  expect(sentDocs[0].caption).toContain("Invoice ready for Dina.");
  expect(sentDocs[0].caption).not.toContain("https://ql.app/l/");
  expect(sentText).toBeNull();

  db.close();
});

test("regression gw-01b: json+md only invoice artifacts never become WA documents", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const rawBotResponse = `Here is the invoice as markdown (bad path).\nhttps://ql.app/l/xyz`;

  let sentText: any = null;
  let sentDoc: any = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: rawBotResponse,
        artifacts: [
          {
            identifier: "invoice_dina_me_dolly",
            title: "invoice_dina_me_dolly",
            artifact_type: "json",
            artifact_reference: { artifact_id: "art-json", version: 0 },
          },
          {
            identifier: "invoice_dina_me_dolly_md",
            title: "invoice.md",
            artifact_type: "markdown",
            artifact_reference: { artifact_id: "art-md", version: 0 },
          },
        ],
      }),
      resolveArtifacts: async () => {
        throw new Error("resolveArtifacts must not be called for json/md-only invoice sidecars");
      },
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: any) => {
        opts.onMessageId("text-only");
        sentText = text;
        return "text-only";
      },
      sendDocument: async (_jid: string, doc: any) => {
        sentDoc = doc;
        return "should-not";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );

  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "inbound-inv-4", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "inbound-inv-4");
  if (claim.status !== "claimed") throw new Error("expected claim");

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "inbound-inv-4", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sentDoc).toBeNull();
  expect(sentText).not.toBeNull();
  expect(sentText).toContain("Here is the invoice as markdown");
  expect(sentText).not.toContain("https://ql.app/l/");
  // No false "couldn't be retrieved" for intentional skips
  expect(sentText).not.toContain("couldn't be retrieved");

  db.close();
});

test("invoice document captions are plain text and short", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });

  const spec = Array.from({ length: 8 }, (_, i) => `**Field ${i}:** \`value ${i}\``).join("\n");
  const rawBotResponse = `### Commercial invoice\n\n**Client:** Noor\n\n${spec}\n\nPlease review the attached invoice.\n<artifact type="file" identifier="sept_invoice_caption" />`;

  let sentDoc: { caption?: string; fileName?: string } | null = null;
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: rawBotResponse,
        artifacts: [
          {
            identifier: "sept_invoice_caption",
            title: "SEPT-INV.pdf",
            artifact_type: "file",
            artifact_reference: { artifact_id: "art-caption", version: 0 },
          },
        ],
      }),
      resolveArtifacts: async () => [{
        ok: true,
        artifact: {
          identifier: "sept_invoice_caption",
          title: "SEPT-INV.pdf",
          fileName: "SEPT-INV.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("%PDF-1.4"),
        },
      }],
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async () => { throw new Error("Should not send plain text when artifact present"); },
      sendDocument: async (_jid: string, doc: { caption?: string; fileName?: string }, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("doc-caption");
        sentDoc = doc;
        return "doc-caption";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );

  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "inbound-caption", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "inbound-caption");
  if (claim.status !== "claimed") throw new Error("expected claim");

  await dispatcher.dispatch({
    workflowId: workflow.id, connectionId: "test-conn", chatJid: chat,
    shopperId: "s", idempotencyKey: "inbound-caption", claimToken: claim.token,
    threadId: "bot", threadEventId: null,
  });

  expect(sentDoc).not.toBeNull();
  expect(sentDoc!.fileName).toBe("SEPT-INV.pdf");
  expect(sentDoc!.caption).toBeDefined();
  expect(sentDoc!.caption).not.toContain("###");
  expect(sentDoc!.caption).not.toContain("**");
  expect(sentDoc!.caption).not.toContain("`");
  expect(sentDoc!.caption).toContain("Commercial invoice");
  expect(sentDoc!.caption).toContain("Client: Noor");
  expect(sentDoc!.caption).not.toContain("Field 7");
  const lines = sentDoc!.caption!.split("\n").filter((line) => line.trim().length > 0);
  expect(lines.length).toBeLessThanOrEqual(4);

  db.close();
});
