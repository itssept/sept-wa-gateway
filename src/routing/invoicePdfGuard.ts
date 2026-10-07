/**
 * Outbound PDF guard.
 *
 * A craft instruction can tell the model to run
 * deal_execution_flow.generate_invoice_pdf, and the model can still answer
 * with a ql.app permalink and no application/pdf artifact (live 2026-10-06,
 * INV-20332). The same leak happens for lookbooks and other documents
 * (live 2026-10-07): a ql.app/l permalink plus a Teach SEPT footer instead
 * of a file. This module decides what WhatsApp is allowed to send:
 *
 *   - a real PDF already on the turn stays attached
 *   - an invoice with no file uses a stored thread PDF, or a SEPT-branded
 *     PDF built only from invoice facts already stated in the turn
 *   - any other PDF/document claim uses a stored non-invoice PDF, or one
 *     honest preparing line
 *
 * The caption on an invoice PDF is one plain sentence. The header is the
 * word SEPT. Nothing here asks for payment credentials, invents settlement
 * details, or builds a lookbook from chat text.
 */

import type { ResolvedArtifact } from "../promptql/promptqlAdapter.ts";
import { operatorRequestsInvoice } from "../craft/orgCraft.ts";
import { sanitizeOutboundText } from "./sanitizer.ts";

export const INVOICE_PDF_CAPTION = "Here is the commercial invoice.";

export const INVOICE_PREPARING_TEXT =
  "Preparing the invoice. I will send it in this chat when it is ready.";

export const DOCUMENT_PDF_CAPTION = "Here is the document.";

export const DOCUMENT_PREPARING_TEXT =
  "Preparing the document. I will send it in this chat when it is ready.";

const INVOICE_WORD = /\b(?:invoices?|receipts?)\b/i;
const DOCUMENT_WORD = /\b(?:pdfs?|lookbooks?|catalog(?:ue)?s?|brochures?|pitch\s+decks?)\b/i;
const DOCUMENT_NOUN =
  /\b(?:here(?:'s| is)|attached|attaching|enclosed|please find)\b[^.!\n]{0,80}\bdocuments?\b/i;
const INVOICE_ID = /\b((?:SEPT-)?INV-\d{3,}(?:-[A-Z0-9]+)*)\b/i;
const PDF_WORD = /\bpdfs?\b/i;
const DELIVERY =
  /\b(?:here(?:'s| is)|attached|attaching|official|enclosed|please find)\b/i;
const AMOUNT =
  /(?:(?:GBP|USD|EUR|AED|SAR|KWD|QAR|CHF|HKD|SGD)\s*\d[\d,]*(?:\.\d{1,2})?)|(?:\d[\d,]*(?:\.\d{1,2})?\s*(?:GBP|USD|EUR|AED|SAR|KWD|QAR|CHF|HKD|SGD))|(?:[£$€]\s*\d[\d,]*(?:\.\d{1,2})?)/i;
const LABELED_CLIENT = /^(?:client|customer|bill to|buyer)\s*[:\-–]\s*(.+)$/im;
const LABELED_ITEM = /^(?:item|piece|description|model)\s*[:\-–]\s*(.+)$/im;
const LABELED_AMOUNT = /^(?:total|amount|price|balance)\s*[:\-–]\s*(.+)$/im;
const PERSON_FOR =
  /\bfor\s+((?:\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*)(?:\s+\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*){1,3})\b/u;
const NAME_TOKEN = /^\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*$/u;

const NON_PDF_TYPES = new Set([
  "json", "markdown", "md", "table", "html", "text",
  "png", "jpeg", "jpg", "image", "visualization",
]);

export interface InvoiceFacts {
  invoiceId: string;
  clientName: string | null;
  item: string | null;
  amountLabel: string | null;
}

export type InvoiceDeliveryDecision =
  | { kind: "unchanged" }
  | { kind: "attach"; source: "thread" | "gateway"; artifact: ResolvedArtifact }
  | { kind: "preparing"; text: string };

/**
 * True when the text the operator would actually see is presenting an invoice
 * or PDF. Judged after outbound sanitizing, so a cancel-banner ql.app link
 * does not turn "Invoice is ready for Noor" into a PDF delivery.
 */
export function claimsInvoiceDelivery(text: string): boolean {
  const visible = sanitizeOutboundText(text);
  if (!visible.trim()) return false;
  const hasInvoice = INVOICE_WORD.test(visible) || INVOICE_ID.test(visible);
  const delivering = DELIVERY.test(visible);
  if (hasInvoice && (PDF_WORD.test(visible) || delivering)) return true;
  return /\b(?:pdf\s+invoices?|invoices?\s+pdf)\b/i.test(visible);
}

/**
 * True when the operator would see a non-invoice PDF or document being
 * handed over (lookbook, catalogue, brochure, "here is the PDF"). Invoice
 * claims stay on the invoice path.
 */
export function claimsDocumentDelivery(text: string): boolean {
  if (claimsInvoiceDelivery(text)) return false;
  const visible = sanitizeOutboundText(text);
  if (DOCUMENT_NOUN.test(text) || DOCUMENT_NOUN.test(visible)) return true;
  if (!DOCUMENT_WORD.test(text) && !DOCUMENT_WORD.test(visible)) return false;
  if (DELIVERY.test(visible) || DELIVERY.test(text)) return true;
  return /ql\.app\/l\//i.test(text);
}

/** A reply that is only a permalink and platform chrome, after sanitizing. */
export function barePermalinkOnly(text: string): boolean {
  if (!/ql\.app\/l\//i.test(text)) return false;
  return sanitizeOutboundText(text).trim() === "";
}

const OPERATOR_DOCUMENT = /\b(?:pdfs?|lookbooks?|catalog(?:ue)?s?|brochures?|pitch\s+decks?)\b/i;

/** True when the operator asked for a PDF or document that is not an invoice. */
export function operatorRequestsDocument(text: string): boolean {
  if (operatorRequestsInvoice(text)) return false;
  return OPERATOR_DOCUMENT.test(text) || DOCUMENT_NOUN.test(text);
}

/** HTML chip, .html name, or an HTML document dumped into the reply. */
export function isHtmlArtifactSignal(
  ref: { identifier: string; type?: string | null },
  title?: string | null,
  artifactType?: string | null,
): boolean {
  const type = (ref.type ?? artifactType ?? "").toLowerCase();
  if (type === "html") return true;
  return /\.html?(?:\b|$)/i.test(`${ref.identifier} ${title ?? ""}`);
}

/**
 * Run the invoice PDF guard when the reply presents an invoice, or when the
 * operator asked for one and the model answered with an HTML chip or a
 * permalink. A clarifying question with neither is left alone.
 */
export function shouldEnforceInvoicePdf(input: {
  reply: string;
  operatorText?: string | null;
  htmlSubstitute: boolean;
}): boolean {
  if (claimsInvoiceDelivery(input.reply)) return true;
  if (!operatorRequestsInvoice(input.operatorText ?? "")) return false;
  if (input.htmlSubstitute) return true;
  if (/ql\.app/i.test(input.reply)) return true;
  if (/<!doctype\s+html|<\s*html\b/i.test(input.reply)) return true;
  return false;
}

/**
 * Run the document PDF guard for lookbooks and other non-invoice files.
 * A clarifying reply with no permalink and no HTML chip is left alone.
 * A reply that is only a ql.app link is not allowed to leave as that link.
 */
export function shouldEnforceDocumentPdf(input: {
  reply: string;
  operatorText?: string | null;
  htmlSubstitute: boolean;
}): boolean {
  if (claimsInvoiceDelivery(input.reply)) return false;
  if (claimsDocumentDelivery(input.reply)) return true;
  if (barePermalinkOnly(input.reply)) return true;
  if (!operatorRequestsDocument(input.operatorText ?? "")) return false;
  if (input.htmlSubstitute) return true;
  if (/ql\.app/i.test(input.reply)) return true;
  if (/<!doctype\s+html|<\s*html\b/i.test(input.reply)) return true;
  return false;
}

export function isApplicationPdf(artifact: { mimeType: string; bytes: Buffer }): boolean {
  const mime = artifact.mimeType.split(";")[0]!.trim().toLowerCase();
  return mime === "application/pdf" && isPdfBuffer(artifact.bytes);
}

export function isPdfBuffer(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

/** A referenced file/pdf/invoice artifact that we already tried to download. */
export function isPdfishArtifactRef(
  ref: { identifier: string; type: string | null },
  title?: string | null,
): boolean {
  const type = (ref.type ?? "").toLowerCase();
  if (NON_PDF_TYPES.has(type)) return false;
  if (type === "pdf" || type === "file" || type === "document") return true;
  return /invoice|sept[_-]inv\b|\.pdf\b/i.test(`${ref.identifier} ${title ?? ""}`);
}

/**
 * Pull only facts the turn already stated. Returns null when there is no
 * invoice id plus at least one of client, item, or amount — a header alone
 * is not an invoice.
 */
export function extractInvoiceFacts(text: string): InvoiceFacts | null {
  const idMatch = INVOICE_ID.exec(text);
  if (!idMatch?.[1]) return null;
  const invoiceId = idMatch[1].replace(/\s+/g, "").toUpperCase();

  let clientName = cleanField(LABELED_CLIENT.exec(text)?.[1] ?? null);
  let item = cleanField(LABELED_ITEM.exec(text)?.[1] ?? null);
  let amountLabel = cleanAmount(LABELED_AMOUNT.exec(text)?.[1] ?? null) ?? cleanAmount(AMOUNT.exec(text)?.[0] ?? null);

  for (const part of partsBesideInvoice(text, invoiceId)) {
    if (!amountLabel && AMOUNT.test(part)) {
      amountLabel = cleanAmount(part);
      continue;
    }
    if (!clientName && looksLikePersonName(part)) {
      clientName = cleanField(part);
      continue;
    }
    if (!item) item = cleanField(part);
  }

  if (!clientName) clientName = cleanField(PERSON_FOR.exec(text)?.[1] ?? null);
  if (!clientName && !item && !amountLabel) return null;
  return { invoiceId, clientName, item, amountLabel };
}

export function ensureInvoiceDelivery(input: {
  reply: string;
  operatorText?: string | null;
  hasPdf: boolean;
  referencedPdf: boolean;
  recovered: ResolvedArtifact | null;
  maxBytes: number;
  issuedOn?: Date;
  /** Caller already decided this turn must not leave without a PDF. */
  enforce?: boolean;
}): InvoiceDeliveryDecision {
  if (input.hasPdf) return { kind: "unchanged" };
  if (!input.enforce && !claimsInvoiceDelivery(input.reply)) return { kind: "unchanged" };

  if (input.recovered && isApplicationPdf(input.recovered) && input.recovered.bytes.length <= input.maxBytes) {
    return { kind: "attach", source: "thread", artifact: input.recovered };
  }

  // A download of an official file/pdf reference failed. Do not replace it
  // with a PDF parsed out of chat — say we are still preparing it.
  if (!input.referencedPdf) {
    const facts = extractInvoiceFacts(`${input.operatorText ?? ""}\n${input.reply}`);
    if (facts) {
      const built = buildSeptInvoicePdf(facts, input.issuedOn);
      if (built.bytes.length <= input.maxBytes && isApplicationPdf(built)) {
        return { kind: "attach", source: "gateway", artifact: built };
      }
    }
  }
  return { kind: "preparing", text: INVOICE_PREPARING_TEXT };
}

export function invoiceDocumentCaption(preservedPrefix?: string): string {
  const prefix = preservedPrefix?.trim();
  if (!prefix) return INVOICE_PDF_CAPTION;
  return `${prefix}\n\n${INVOICE_PDF_CAPTION}`;
}

function invoiceNamedArtifact(artifact: { identifier: string; fileName: string; title: string }): boolean {
  return /invoice|sept[_-]inv\b/i.test(`${artifact.identifier} ${artifact.fileName} ${artifact.title}`);
}

/**
 * Invoice turns keep the invoice decision (stored PDF, facts PDF, or the
 * invoice preparing line). Every other enforced document turn attaches a
 * non-invoice PDF or says the document is still being prepared. A lookbook
 * is never invented from chat text.
 */
export function ensureOutboundPdf(input: {
  reply: string;
  operatorText?: string | null;
  hasPdf: boolean;
  referencedPdf: boolean;
  recovered: ResolvedArtifact | null;
  maxBytes: number;
  issuedOn?: Date;
  enforceInvoice: boolean;
  enforceDocument: boolean;
}): InvoiceDeliveryDecision {
  if (input.hasPdf) return { kind: "unchanged" };
  if (!input.enforceInvoice && !input.enforceDocument) return { kind: "unchanged" };

  const recovered = input.recovered;
  const recoveredOk = Boolean(
    recovered && isApplicationPdf(recovered) && recovered.bytes.length <= input.maxBytes,
  );
  const wrongInvoice = Boolean(
    recoveredOk && recovered && input.enforceDocument && !input.enforceInvoice && invoiceNamedArtifact(recovered),
  );
  if (recoveredOk && recovered && !wrongInvoice) {
    return { kind: "attach", source: "thread", artifact: recovered };
  }

  if (input.enforceInvoice) {
    return ensureInvoiceDelivery({
      reply: input.reply,
      operatorText: input.operatorText,
      hasPdf: false,
      referencedPdf: input.referencedPdf,
      recovered: null,
      maxBytes: input.maxBytes,
      issuedOn: input.issuedOn,
      enforce: true,
    });
  }
  return { kind: "preparing", text: DOCUMENT_PREPARING_TEXT };
}

/** Branded one-page invoice. Header is the word SEPT. Fields are the ones passed in. */
export function buildSeptInvoicePdf(facts: InvoiceFacts, issuedOn = new Date()): ResolvedArtifact {
  const lines: Array<{ text: string; font: "F1" | "F2"; size: number; gap: number }> = [
    { text: "SEPT", font: "F1", size: 20, gap: 28 },
    { text: "Commercial Invoice", font: "F2", size: 11, gap: 22 },
    { text: `Invoice No: ${facts.invoiceId}`, font: "F2", size: 11, gap: 16 },
    { text: `Date: ${formatIssuedDate(issuedOn)}`, font: "F2", size: 11, gap: 16 },
  ];
  if (facts.clientName) lines.push({ text: `Client: ${facts.clientName}`, font: "F2", size: 11, gap: 16 });
  if (facts.item) lines.push({ text: `Item: ${facts.item}`, font: "F2", size: 11, gap: 16 });
  if (facts.amountLabel) lines.push({ text: `Total: ${facts.amountLabel}`, font: "F2", size: 11, gap: 16 });

  const bytes = renderPdf(lines);
  const fileName = invoiceFileName(facts.invoiceId);
  return {
    identifier: `sept_invoice_${facts.invoiceId.toLowerCase()}`,
    title: fileName,
    fileName,
    mimeType: "application/pdf",
    bytes,
  };
}

function partsBesideInvoice(text: string, invoiceId: string): string[] {
  const line = text.split(/\n/).find((l) => l.toUpperCase().includes(invoiceId));
  if (!line) return [];
  const idx = line.toUpperCase().indexOf(invoiceId);
  const after = line.slice(idx + invoiceId.length);
  const paren = /^\s*\(([^)]*)\)/.exec(after);
  const body = (paren ? paren[1] : after.replace(/^[\s:,\-–]+/, "")) ?? "";
  return body.split(",").map((part) => part.trim()).filter(Boolean);
}

function looksLikePersonName(part: string): boolean {
  const words = part.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((word) => NAME_TOKEN.test(word));
}

function cleanField(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || null;
}

function cleanAmount(value: string | null): string | null {
  const cleaned = cleanField(value);
  if (!cleaned || !AMOUNT.test(cleaned)) return null;
  return cleaned;
}

function formatIssuedDate(date: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function invoiceFileName(invoiceId: string): string {
  const safe = invoiceId.replace(/[^A-Za-z0-9.-]/g, "");
  const base = /^SEPT-/i.test(safe) ? safe : `SEPT-${safe}`;
  return `${base}.pdf`;
}

function pdfEscape(text: string): string {
  // Helvetica is WinAnsi. Keep the stated ASCII facts; drop the rest.
  const ascii = text.replace(/[^\x20-\x7E]/g, "?");
  return ascii.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function renderPdf(lines: Array<{ text: string; font: "F1" | "F2"; size: number; gap: number }>): Buffer {
  const commands = ["BT"];
  let first = true;
  for (const line of lines) {
    if (!line.text) continue;
    commands.push(`/${line.font} ${line.size} Tf`);
    commands.push(first ? "72 740 Td" : `0 -${line.gap} Td`);
    commands.push(`(${pdfEscape(line.text)}) Tj`);
    first = false;
  }
  commands.push("ET");
  const stream = commands.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
