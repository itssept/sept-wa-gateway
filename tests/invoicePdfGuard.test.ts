import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import {
  INVOICE_PDF_CAPTION,
  INVOICE_PREPARING_TEXT,
  buildSeptInvoicePdf,
  claimsInvoiceDelivery,
  extractInvoiceFacts,
} from "../src/routing/invoicePdfGuard.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

const LIVE_ASK = "PDF invoice for INV-20332 (Dina AlJuffali, Chanel Paris-Dallas bowling bag, GBP 8100)";
const LIVE_REPLY = "Here is the official commercial invoice PDF\nhttps://ql.app/l/AbCdEf12";

test("invoice delivery claims are specific", () => {
  expect(claimsInvoiceDelivery(LIVE_REPLY)).toBe(true);
  expect(claimsInvoiceDelivery("Here is the invoice as markdown\nhttps://ql.app/l/xyz")).toBe(true);
  expect(claimsInvoiceDelivery("The invoice will be ready tomorrow.")).toBe(false);
  expect(claimsInvoiceDelivery("What invoice number did we use for the Kelly?")).toBe(false);
  expect(claimsInvoiceDelivery("The Kelly 28 is available in gold.")).toBe(false);
  expect(claimsInvoiceDelivery("Here is the catalogue PDF.")).toBe(false);
  expect(claimsInvoiceDelivery(
    "Invoice is ready for Noor.\n\n⚠️ SEPT's run was cancelled before it could finish.\nhttps://ql.app/l/AbCdEf12\n\nTotal $5,000.",
  )).toBe(false);
});

test("extracts the live INV-20332 facts and builds a SEPT PDF", () => {
  const facts = extractInvoiceFacts(LIVE_ASK);
  expect(facts).toEqual({
    invoiceId: "INV-20332",
    clientName: "Dina AlJuffali",
    item: "Chanel Paris-Dallas bowling bag",
    amountLabel: "GBP 8100",
  });
  const pdf = buildSeptInvoicePdf(facts!, new Date(Date.UTC(2026, 9, 6)));
  const body = pdf.bytes.toString("latin1");
  expect(pdf.mimeType).toBe("application/pdf");
  expect(pdf.fileName).toBe("SEPT-INV-20332.pdf");
  expect(body.startsWith("%PDF-")).toBe(true);
  expect(body).toContain("(SEPT)");
  expect(body).toContain("INV-20332");
  expect(body).toContain("Dina AlJuffali");
  expect(body).toContain("Chanel Paris-Dallas bowling bag");
  expect(body).toContain("GBP 8100");
  expect(body).toContain("6 October 2026");
  expect(body).not.toContain("SEPT LUXURY CONCIERGE");
  expect(body.toLowerCase()).not.toContain("stripe");
  expect(body.toLowerCase()).not.toContain("quickbooks");
  expect(body.toLowerCase()).not.toContain("xero");
  expect(body.toLowerCase()).not.toContain("iban");
  expect(extractInvoiceFacts("Here is the official commercial invoice PDF")).toBeNull();
});

test("the in-repo invoice program does not use the generic luxury header", () => {
  const source = readFileSync(new URL("../src/modules/recognition/deal_execution_flow.py", import.meta.url), "utf8");
  expect(source).not.toContain("SEPT LUXURY CONCIERGE");
  expect(source).toContain('Paragraph("SEPT"');
});

function dispatchHarness(
  ctx: ReturnType<typeof makeTestApp>["ctx"],
  reply: string,
  extras?: {
    artifacts?: unknown[];
    resolve?: (refs: unknown[]) => unknown[];
    recover?: () => Promise<{ bytes: Buffer; fileName: string; mimeType: string; identifier: string; title: string } | null>;
    operatorText?: string;
  },
) {
  const sent: { text?: string; doc?: { fileName: string; mimeType: string; caption?: string; bytes: Buffer } } = {};
  const adapter = {
    waitForResponse: async () => ({
      status: "completed" as const,
      message: reply,
      artifacts: extras?.artifacts ?? [],
    }),
    resolveArtifacts: async (_identity: unknown, _arts: unknown, refs: unknown[]) => {
      if (!extras?.resolve) return [];
      return extras.resolve(refs);
    },
    ...(extras?.recover ? { recoverInvoicePdf: async () => extras.recover!() } : {}),
  };
  const dispatcher = new OutboundDispatcher(
    adapter as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("text-1");
        sent.text = text;
        return "text-1";
      },
      sendDocument: async (_jid: string, doc: { fileName: string; mimeType: string; caption?: string; bytes: Buffer }, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("doc-1");
        sent.doc = doc;
        return "doc-1";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );
  return { dispatcher, sent };
}

async function claimAndDispatch(
  ctx: ReturnType<typeof makeTestApp>["ctx"],
  dispatcher: OutboundDispatcher,
  key: string,
  operatorText?: string,
) {
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: key, remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", key);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: key,
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
    operatorText,
  });
}

test("PDF artifact present is attached and the caption is one plain sentence", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const pdf = Buffer.from("%PDF-1.4 official");
  const { dispatcher, sent } = dispatchHarness(ctx, `${LIVE_REPLY}\n<artifact type="file" identifier="sept_invoice_20332" />`, {
    artifacts: [{
      identifier: "sept_invoice_20332",
      title: "SEPT-INV-20332.pdf",
      artifact_type: "file",
      artifact_reference: { artifact_id: "art-pdf", version: 0 },
    }],
    resolve: () => [{
      ok: true,
      artifact: {
        identifier: "sept_invoice_20332",
        title: "SEPT-INV-20332.pdf",
        fileName: "SEPT-INV-20332.pdf",
        mimeType: "application/pdf",
        bytes: pdf,
      },
    }],
  });
  await claimAndDispatch(ctx, dispatcher, "pdf-present", LIVE_ASK);
  expect(sent.text).toBeUndefined();
  expect(sent.doc?.mimeType).toBe("application/pdf");
  expect(sent.doc?.bytes.toString("latin1")).toBe("%PDF-1.4 official");
  expect(sent.doc?.caption).toBe(INVOICE_PDF_CAPTION);
  expect(sent.doc?.caption).not.toContain("ql.app");
  expect(sent.doc?.caption).not.toMatch(/[*_`#]/);
  db.close();
});

test("invoice claim with no artifact attaches a branded PDF from the operator's facts", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const { dispatcher, sent } = dispatchHarness(ctx, LIVE_REPLY);
  await claimAndDispatch(ctx, dispatcher, "pdf-missing", LIVE_ASK);
  expect(sent.text).toBeUndefined();
  expect(sent.doc?.mimeType).toBe("application/pdf");
  expect(sent.doc?.fileName).toBe("SEPT-INV-20332.pdf");
  expect(sent.doc?.caption).toBe(INVOICE_PDF_CAPTION);
  const body = sent.doc!.bytes.toString("latin1");
  expect(body.startsWith("%PDF-")).toBe(true);
  expect(body).toContain("(SEPT)");
  expect(body).toContain("INV-20332");
  expect(body).toContain("Dina AlJuffali");
  expect(body).toContain("Chanel Paris-Dallas bowling bag");
  expect(body).toContain("GBP 8100");
  expect(body).not.toContain("SEPT LUXURY CONCIERGE");
  expect(body).not.toContain("ql.app");
  expect(sent.doc?.caption).not.toContain("ql.app");
  db.close();
});

test("invoice claim with no facts and no PDF says it is preparing and does not send a link", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const { dispatcher, sent } = dispatchHarness(ctx, LIVE_REPLY);
  await claimAndDispatch(ctx, dispatcher, "pdf-preparing");
  expect(sent.doc).toBeUndefined();
  expect(sent.text).toBe(INVOICE_PREPARING_TEXT);
  expect(sent.text).not.toContain("ql.app");
  expect(sent.text?.toLowerCase()).not.toContain("here is the official");
  expect(sent.text?.toLowerCase()).not.toContain("stripe");
  expect(sent.text).not.toMatch(/[*_`#]/);
  db.close();
});

test("a stored thread PDF is attached instead of a chat-built invoice", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const stored = Buffer.from("%PDF-1.4 stored-artifact");
  const { dispatcher, sent } = dispatchHarness(ctx, LIVE_REPLY, {
    recover: async () => ({
      identifier: "sept_invoice_20332",
      title: "INV-20332.pdf",
      fileName: "INV-20332.pdf",
      mimeType: "application/pdf",
      bytes: stored,
    }),
  });
  await claimAndDispatch(ctx, dispatcher, "pdf-recovered", LIVE_ASK);
  expect(sent.text).toBeUndefined();
  expect(sent.doc?.bytes.toString("latin1")).toBe("%PDF-1.4 stored-artifact");
  expect(sent.doc?.caption).toBe(INVOICE_PDF_CAPTION);
  expect(sent.doc?.caption).not.toContain("ql.app");
  db.close();
});

test("a failed official PDF download is not replaced by a chat-built file", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const { dispatcher, sent } = dispatchHarness(
    ctx,
    `Here is the official commercial invoice PDF\n<artifact type="file" identifier="sept_invoice_20332" />`,
    {
      artifacts: [{
        identifier: "sept_invoice_20332",
        title: "SEPT-INV-20332.pdf",
        artifact_type: "file",
        artifact_reference: { artifact_id: "art-pdf", version: 0 },
      }],
      resolve: () => [{ ok: false, identifier: "sept_invoice_20332", reason: "unavailable" }],
    },
  );
  await claimAndDispatch(ctx, dispatcher, "pdf-failed", LIVE_ASK);
  expect(sent.doc).toBeUndefined();
  expect(sent.text).toBe(INVOICE_PREPARING_TEXT);
  expect(sent.text).not.toContain("ql.app");
  expect(sent.text).not.toContain("INV-20332");
  db.close();
});

test("HTML invoice chip on 'invoice this' is not sent; no facts becomes the preparing line", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const html = Buffer.from("<!DOCTYPE html><html><body><h1>Invoice</h1></body></html>");
  const { dispatcher, sent } = dispatchHarness(
    ctx,
    "Commercial invoice\nhttps://ql.app/l/AbCdEf12\n<artifact type=\"html\" identifier=\"invoice_card\" />",
    {
      artifacts: [{
        identifier: "invoice_card",
        title: "Invoice",
        artifact_type: "html",
        artifact_reference: { artifact_id: "art-html", version: 0 },
      }],
      resolve: () => [{
        ok: true,
        artifact: {
          identifier: "invoice_card",
          title: "Invoice",
          fileName: "invoice.html",
          mimeType: "application/pdf",
          bytes: html,
        },
      }],
    },
  );
  await claimAndDispatch(ctx, dispatcher, "html-chip", "Invoice this");
  expect(sent.doc).toBeUndefined();
  expect(sent.text).toBe(INVOICE_PREPARING_TEXT);
  expect(sent.text).not.toContain("ql.app");
  expect(sent.text?.toLowerCase()).not.toContain("<html");
  db.close();
});

test("HTML chip plus invoice facts becomes a branded PDF, not the chip", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const { dispatcher, sent } = dispatchHarness(
    ctx,
    "<artifact type=\"html\" identifier=\"invoice_card\" />",
    {
      artifacts: [{
        identifier: "invoice_card",
        title: "invoice.html",
        artifact_type: "file",
        artifact_reference: { artifact_id: "art-html", version: 0 },
      }],
      resolve: () => [{ ok: false, identifier: "invoice_card", reason: "not_attachable" }],
    },
  );
  await claimAndDispatch(ctx, dispatcher, "html-facts", LIVE_ASK);
  expect(sent.text).toBeUndefined();
  expect(sent.doc?.mimeType).toBe("application/pdf");
  expect(sent.doc?.bytes.toString("latin1").startsWith("%PDF-")).toBe(true);
  expect(sent.doc?.caption).toBe(INVOICE_PDF_CAPTION);
  expect(sent.doc?.bytes.toString("latin1")).toContain("INV-20332");
  expect(sent.doc?.bytes.toString("latin1")).not.toContain("<html");
  db.close();
});

test("an invoice question is not replaced when the reply is a clarification", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const reply = "Which client should I use?";
  const { dispatcher, sent } = dispatchHarness(ctx, reply);
  await claimAndDispatch(ctx, dispatcher, "clarify", "Invoice this");
  expect(sent.doc).toBeUndefined();
  expect(sent.text).toBe(reply);
  db.close();
});

test("non-invoice messages are unchanged", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const status = "The Kelly 28 is available in gold.";
  const question = "What invoice number did we use for the Kelly?";
  const first = dispatchHarness(ctx, status);
  await claimAndDispatch(ctx, first.dispatcher, "status-1");
  expect(first.sent.text).toBe(status);
  expect(first.sent.doc).toBeUndefined();

  const second = dispatchHarness(ctx, question);
  await claimAndDispatch(ctx, second.dispatcher, "status-2");
  expect(second.sent.text).toBe(question);
  expect(second.sent.doc).toBeUndefined();
  db.close();
});
