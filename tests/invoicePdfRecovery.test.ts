/**
 * Live SFO3 sha-06115ba: an invoice turn logged not_attachable twice and
 * "pdf recovery failed" once, with the invoice-request contract on the ask.
 * The PDF was in the download, but the first block was an HTML chip or a
 * permalink, the listing version was a string, or the bytes did not start
 * at %PDF-. WhatsApp then had nothing to attach.
 */

import { expect, test, afterEach } from "bun:test";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import { PromptQlAdapter, orderStoredPdfIdentifiers } from "../src/promptql/promptqlAdapter.ts";
import { INVOICE_PDF_CAPTION, INVOICE_PREPARING_TEXT } from "../src/routing/invoicePdfGuard.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseOf(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

function scriptByTool(toolResults: Array<{ result: unknown }>): { toolCalls: Array<{ name: string; args: Record<string, unknown> }> } {
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let toolIdx = 0;
  globalThis.fetch = (async (_input: unknown, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}");
    const headers = new Headers({ "content-type": "text/event-stream" });
    if (body.method === "initialize") {
      return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: {} }), { headers });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") {
      toolCalls.push({ name: body.params.name, args: body.params.arguments });
      const next = toolResults[toolIdx++];
      return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: next?.result ?? {} }), { headers });
    }
    return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: {} }), { headers });
  }) as typeof fetch;
  return { toolCalls };
}

const deps = { config: testConfig(), getToken: () => "tok" };
const pdf = Buffer.from("%PDF-1.4\ninvoice-bytes");

test("a PDF block after an HTML chip is the attachment, not not_attachable", async () => {
  scriptByTool([
    { result: { content: [
      { type: "text", text: "<!DOCTYPE html><html><body>Invoice chip</body></html>", mimeType: "text/html" },
      { type: "resource", resource: { blob: pdf.toString("base64"), mimeType: "application/pdf" } },
    ] } },
    { result: { content: [
      { type: "text", text: "{\"invoice\":true}", mimeType: "application/json" },
    ] } },
  ]);
  const out = await new PromptQlAdapter(deps).resolveArtifacts(
    "shopper-1",
    [
      { identifier: "sept_invoice_20332", title: "invoice.html", artifact_type: "file", artifact_reference: { artifact_id: "pdf", version: 0 } },
      { identifier: "invoice_sidecar", title: "invoice.json", artifact_type: "file", artifact_reference: { artifact_id: "json", version: 0 } },
    ],
    [
      { identifier: "sept_invoice_20332", type: "file" },
      { identifier: "invoice_sidecar", type: "file" },
    ],
    1024 * 1024,
  );
  expect(out[0]?.ok).toBe(true);
  if (out[0]?.ok) {
    expect(out[0].artifact.mimeType).toBe("application/pdf");
    expect(out[0].artifact.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(out[0].artifact.fileName.endsWith(".pdf")).toBe(true);
    expect(out[0].artifact.bytes.toString("latin1")).toContain("invoice-bytes");
  }
  expect(out[1]).toMatchObject({ ok: false, identifier: "invoice_sidecar", reason: "not_attachable" });
});

test("base64 PDF inside an invoice JSON chip is attached", async () => {
  const chip = JSON.stringify({ file: pdf.toString("base64") });
  scriptByTool([
    { result: { content: [{ type: "text", text: chip, mimeType: "application/json" }] } },
  ]);
  const out = await new PromptQlAdapter(deps).resolveArtifacts(
    "shopper-1",
    [{ identifier: "sept_invoice_20332", title: "invoice.json", artifact_type: "file", artifact_reference: { artifact_id: "j", version: 0 } }],
    [{ identifier: "sept_invoice_20332", type: "file" }],
    1024 * 1024,
  );
  expect(out[0]?.ok).toBe(true);
  if (out[0]?.ok) {
    expect(out[0].artifact.mimeType).toBe("application/pdf");
    expect(out[0].artifact.bytes.toString("latin1")).toContain("invoice-bytes");
  }
});

test("BOM and charset still produce a PDF that starts at %PDF-", async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pdf]);
  scriptByTool([
    { result: { content: [{ type: "resource", resource: { blob: bom.toString("base64"), mimeType: "application/pdf; charset=binary" } }] } },
  ]);
  const out = await new PromptQlAdapter(deps).resolveArtifacts(
    "shopper-1",
    [{ identifier: "sept_invoice_20332", title: "invoice.html", artifact_type: "file", artifact_reference: { artifact_id: "p", version: 0 } }],
    [{ identifier: "sept_invoice_20332", type: "file" }],
    1024 * 1024,
  );
  expect(out[0]?.ok).toBe(true);
  if (out[0]?.ok) {
    expect(out[0].artifact.mimeType).toBe("application/pdf");
    expect(out[0].artifact.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(out[0].artifact.fileName.endsWith(".pdf")).toBe(true);
  }
});

test("an HTML invoice chip keeps the stated facts and is not a document", async () => {
  const html = "<html><body>INV-20332 for Dina AlJuffali, Chanel bag, GBP 8100</body></html>";
  scriptByTool([
    { result: { content: [{ type: "text", text: html, mimeType: "text/html" }] } },
  ]);
  const out = await new PromptQlAdapter(deps).resolveArtifacts(
    "shopper-1",
    [{ identifier: "sept_invoice_20332", title: "invoice.html", artifact_type: "file", artifact_reference: { artifact_id: "h", version: 0 } }],
    [{ identifier: "sept_invoice_20332", type: "file" }],
    1024 * 1024,
  );
  expect(out[0]).toMatchObject({ ok: false, reason: "not_attachable" });
  if (!out[0]?.ok) {
    expect(out[0].factText).toContain("INV-20332");
    expect(out[0].factText).toContain("Dina AlJuffali");
    expect(out[0].factText).not.toContain("<html");
  }
});

test("recovery reads a string version and a PDF listed only as content JSON", async () => {
  const { toolCalls } = scriptByTool([
    { result: { structuredContent: {}, content: [{ type: "text", text: JSON.stringify({ artifacts: [
      {
        identifier: "invoice_card",
        title: "invoice.html",
        artifact_type: "html",
        artifact_reference: { artifact_id: "html", version: "0" },
      },
      {
        identifier: "sept_invoice_20332",
        title: "INV-20332.pdf",
        artifact_type: "file",
        artifact_reference: { artifact_id: "pdf", version: "0" },
        metadata: { file: { content_type: "application/pdf", file_name: "INV-20332.pdf" } },
      },
    ] }) }] } },
    { result: { content: [
      { type: "text", text: "https://ql.app/l/AbCdEf12" },
      { type: "resource", resource: { blob: pdf.toString("base64"), mimeType: "application/octet-stream" } },
    ] } },
  ]);
  const art = await new PromptQlAdapter(deps).recoverInvoicePdf("shopper-1", "thread-1", 1024 * 1024);
  expect(toolCalls.map((call) => call.name)).toEqual([
    "list_promptql_thread_artifact_metadata",
    "download_promptql_artifact",
  ]);
  expect(toolCalls[1]?.args).toEqual({ artifact_id: "pdf", version: 0 });
  expect(art?.mimeType).toBe("application/pdf");
  expect(art?.bytes.toString("latin1")).toContain("invoice-bytes");
});

test("a https PDF URL is fetched when the block has no bytes; a ql.app link is not", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes("example.test")) {
      const body = JSON.parse(init?.body ?? "{}");
      const headers = new Headers({ "content-type": "text/event-stream" });
      if (body.method === "initialize") {
        return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: {} }), { headers });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(sseOf({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "resource", resource: { uri: "https://cdn.example/INV-20332.pdf", mimeType: "application/pdf" } }] },
      }), { headers });
    }
    urls.push(url);
    return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  const out = await new PromptQlAdapter(deps).resolveArtifacts(
    "shopper-1",
    [{ identifier: "sept_invoice_20332", title: "INV-20332.pdf", artifact_type: "file", artifact_reference: { artifact_id: "p", version: 0 } }],
    [{ identifier: "sept_invoice_20332", type: "file" }],
    1024 * 1024,
  );
  expect(urls).toEqual(["https://cdn.example/INV-20332.pdf"]);
  expect(out[0]?.ok).toBe(true);
  if (out[0]?.ok) expect(out[0].artifact.bytes.toString("latin1")).toContain("invoice-bytes");
});

test("recovery does not reject when the thread id is not a string", async () => {
  const art = await new PromptQlAdapter(deps).recoverInvoicePdf("shopper-1", 12 as never, 1024);
  expect(art).toBeNull();
});

test("string versions and content-JSON listings stay in invoice order and out of lookbooks", () => {
  const wrapped = {
    structuredContent: {},
    content: [{ type: "text", text: JSON.stringify({ artifacts: [
      {
        identifier: "sept_invoice_20332",
        title: "INV-20332.pdf",
        artifact_type: "file",
        artifact_reference: { artifact_id: "pdf", version: "0" },
        metadata: { file: { content_type: "application/pdf", file_name: "INV-20332.pdf" } },
      },
      {
        identifier: "invoice_card",
        title: "invoice.json",
        artifact_type: "json",
        artifact_reference: { artifact_id: "json", version: "1" },
      },
      {
        identifier: "fw26_lookbook",
        title: "FW26 Lookbook.pdf",
        artifact_type: "pdf",
        mime_type: "application/pdf",
        artifact_reference: { artifact_id: "book", version: 0 },
      },
    ] }) }],
  };
  expect(orderStoredPdfIdentifiers(wrapped, "invoice")).toEqual([
    "sept_invoice_20332",
    "fw26_lookbook",
    "invoice_card",
  ]);
  expect(orderStoredPdfIdentifiers(wrapped, "document")).toEqual(["fw26_lookbook"]);
});

test("invoice facts trapped in a not_attachable chip become the branded PDF", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const sent: { text?: string; doc?: { fileName: string; mimeType: string; caption?: string; bytes: Buffer } } = {};
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: "Here is the invoice\nhttps://ql.app/l/AbCdEf12\n<artifact type=\"file\" identifier=\"invoice_card\" />",
        artifacts: [{
          identifier: "invoice_card",
          title: "invoice.html",
          artifact_type: "file",
          artifact_reference: { artifact_id: "h", version: 0 },
        }],
      }),
      resolveArtifacts: async () => [{
        ok: false,
        identifier: "invoice_card",
        reason: "not_attachable",
        factText: "INV-20332 for Dina AlJuffali, Chanel bag, GBP 8100",
      }],
      recoverInvoicePdf: async () => {
        throw new Error("pdf recovery failed");
      },
    } as never,
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
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "chip-facts", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "chip-facts");
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: "chip-facts",
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
    operatorText: "Invoice this",
  });
  expect(sent.text).toBeUndefined();
  expect(sent.doc?.mimeType).toBe("application/pdf");
  expect(sent.doc?.caption).toBe(INVOICE_PDF_CAPTION);
  expect(sent.doc?.bytes.toString("latin1")).toContain("INV-20332");
  expect(sent.doc?.bytes.toString("latin1")).toContain("(SEPT)");
  expect(sent.doc?.bytes.toString("latin1")).not.toContain("SEPT LUXURY CONCIERGE");
  expect(sent.text ?? "").not.toBe(INVOICE_PREPARING_TEXT);
  db.close();
});

test("a PDF with a BOM and an html filename is sent as application/pdf", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("%PDF-1.4 official-bytes")]);
  const sent: { doc?: { fileName: string; mimeType: string; bytes: Buffer } } = {};
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: "Here is the invoice\n<artifact type=\"file\" identifier=\"sept_invoice_20332\" />",
        artifacts: [{
          identifier: "sept_invoice_20332",
          title: "invoice.html",
          artifact_type: "file",
          artifact_reference: { artifact_id: "p", version: 0 },
        }],
      }),
      resolveArtifacts: async () => [{
        ok: true,
        artifact: {
          identifier: "sept_invoice_20332",
          title: "invoice.html",
          fileName: "invoice.html",
          mimeType: "application/pdf; charset=binary",
          bytes,
        },
      }],
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async () => { throw new Error("text"); },
      sendDocument: async (_jid: string, doc: { fileName: string; mimeType: string; bytes: Buffer }, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("doc-1");
        sent.doc = doc;
        return "doc-1";
      },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "bom-pdf", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "bom-pdf");
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: "bom-pdf",
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
    operatorText: "Invoice this",
  });
  expect(sent.doc?.mimeType).toBe("application/pdf");
  expect(sent.doc?.fileName.endsWith(".pdf")).toBe(true);
  expect(sent.doc?.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(sent.doc?.bytes.toString("latin1")).toContain("official-bytes");
  db.close();
});

test("an unavailable official PDF is still not replaced by a chat-built file", async () => {
  const { ctx, db } = makeTestApp(testConfig({ logLevel: "info" }));
  const chat = "operator@s.whatsapp.net";
  ctx.chatBots.upsert({ connectionId: "test-conn", chatJid: chat, shopperId: "s", threadId: "bot" });
  const sent: { text?: string } = {};
  const dispatcher = new OutboundDispatcher(
    {
      waitForResponse: async () => ({
        status: "completed",
        message: "Here is the official commercial invoice PDF\n<artifact type=\"file\" identifier=\"sept_invoice_20332\" />",
        artifacts: [{
          identifier: "sept_invoice_20332",
          title: "SEPT-INV-20332.pdf",
          artifact_type: "file",
          artifact_reference: { artifact_id: "p", version: 0 },
        }],
      }),
      resolveArtifacts: async () => [{ ok: false, identifier: "sept_invoice_20332", reason: "unavailable" }],
      recoverInvoicePdf: async () => null,
    } as never,
    ctx.workflows,
    ctx.outboundLog,
    {
      sendText: async (_jid: string, text: string, opts: { onMessageId: (id: string) => void }) => {
        opts.onMessageId("text-1");
        sent.text = text;
        return "text-1";
      },
      sendDocument: async () => { throw new Error("no document"); },
    } as never,
    ctx.config,
    ctx.log,
    ctx.chatBots,
  );
  const workflow = ctx.workflows.create({
    connectionId: "test-conn", chatJid: chat, shopperId: "s", inboundMessageId: "still-preparing", remoteRef: "bot",
  });
  const claim = ctx.outboundLog.claim("test-conn", "still-preparing");
  if (claim.status !== "claimed") throw new Error("expected claim");
  await dispatcher.dispatch({
    workflowId: workflow.id,
    connectionId: "test-conn",
    chatJid: chat,
    shopperId: "s",
    idempotencyKey: "still-preparing",
    claimToken: claim.token,
    threadId: "bot",
    threadEventId: null,
    operatorText: "PDF invoice for INV-20332 (Dina AlJuffali, Chanel bag, GBP 8100)",
  });
  expect(sent.text).toBe(INVOICE_PREPARING_TEXT);
  db.close();
});
