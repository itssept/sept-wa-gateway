import { readFileSync as defaultReadFileSync } from "node:fs";
import { z } from "zod";
import bundledPlaybooks from "./playbooks.json";

/**
 * Issue #25 — org shared craft inject (procedural only, zero per-seat PII).
 *
 * Self-serve path that does NOT need Postgres DDL / Virtual SQL CREATE TABLE:
 * load craft from ORG_CRAFT_SYSTEM_INSTRUCTION, ORG_CRAFT_FILE (JSON), or
 * the bundled playbook pack, then pass as ask_promptql system_instruction.
 *
 * FORBIDDEN in craft text: client/phone/price/margin/quote/bank/supplier/contact PII.
 */

export type OrgCraftCategory =
  | "invoice_pattern"
  | "item_id"
  | "sizing"
  | "market_tags"
  | "procedural_craft";

export type OrgCraftPlaybook = {
  playbook_key: string;
  category: OrgCraftCategory;
  title: string;
  instructions: string;
};

const PII_KEY_RE =
  /\b(client_\w*|phone|e164|price|margin|quote|bank_\w*|supplier_\w*|contact_\w*|iban)\b/i;

const PlaybookSchema = z.object({
  playbook_key: z.string().trim().min(1).max(100),
  category: z.enum(["invoice_pattern", "item_id", "sizing", "market_tags", "procedural_craft"]),
  title: z.string().trim().min(1).max(255),
  instructions: z.string().trim().min(1),
}).strict();

function parsePlaybooks(raw: unknown): OrgCraftPlaybook[] {
  if (!Array.isArray(raw)) return [];
  const out: OrgCraftPlaybook[] = [];
  for (const entry of raw) {
    const parsed = PlaybookSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const DEFAULT_CRAFT_PLAYBOOKS: OrgCraftPlaybook[] = parsePlaybooks(bundledPlaybooks);

export function assertCraftOnly(playbook: OrgCraftPlaybook): void {
  const blob = `${playbook.playbook_key}\n${playbook.title}\n${playbook.instructions}`;
  if (PII_KEY_RE.test(blob)) {
    throw new Error(`org craft rejected: PII-shaped content in ${playbook.playbook_key}`);
  }
}

export function formatCraftSystemInstruction(playbooks: OrgCraftPlaybook[]): string {
  const clean = playbooks.filter((p) => {
    try {
      assertCraftOnly(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!clean.length) return "";
  const body = clean
    .map(
      (p) =>
        `### ${p.category}/${p.playbook_key} — ${p.title}\n${p.instructions.trim()}`,
    )
    .join("\n\n");
  return [
    "ORG SHARED CRAFT (procedural only — zero per-seat PII).",
    "Private ledger stays firewalled. Do not echo another operator's book.",
    body,
  ].join("\n\n");
}

export type OrgCraftLoadOptions = {
  enabled: boolean;
  /** Raw system instruction override (already craft-only). */
  inlineInstruction?: string;
  /** Path to JSON array of OrgCraftPlaybook. */
  filePath?: string;
  /** Fallback seeds when no inline/file content. */
  useDefaults?: boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
};

/**
 * An inline or file override must not drop the invoice PDF contract.
 * Live 2026-10-06: "Invoice this" finished as an HTML chip because the model
 * never called generate_invoice_pdf.
 */
function ensureInvoicePlaybook(text: string): string {
  if (text.includes("function generate_invoice_pdf") && text.includes("application/pdf")) return text;
  const invoice = DEFAULT_CRAFT_PLAYBOOKS.filter((p) => p.playbook_key === "invoice_pdf_luxury_caption");
  const block = formatCraftSystemInstruction(invoice);
  if (!block) return text;
  return `${text.trim()}\n\n${block}`;
}

/** Short, turn-scoped force. Shopper text stays untouched; this rides system_instruction. */
export const INVOICE_TURN_CONTRACT =
  "THIS TURN IS AN INVOICE REQUEST. You MUST run program sept_multimodal_recognition file deal_execution_flow.py function generate_invoice_pdf and return the application/pdf artifact instead of a link. A permalink is not an invoice. An HTML chip is not an invoice. Emit only <artifact type=\"file\" identifier=\"sept_invoice_<deal_id>\" /> whose bytes are application/pdf. Do not return HTML, markdown, JSON, or a visualization chip. If the PDF cannot be produced, say the invoice is being prepared. Never ask for payment credentials.";

/**
 * True when the operator asked for an invoice or receipt. Questions
 * ("what invoice number") are not requests. The media-bridge wrapper is
 * ignored so "invoice generation" in that boilerplate does not match.
 */
export function operatorRequestsInvoice(text: string): boolean {
  const operator = (text.split(/Operator message:\s*/i).pop() ?? text).trim();
  if (!operator) return false;
  if (/^\s*(?:what|which|when|where|who|why|how)\b/i.test(operator)) return false;
  return /\b(?:invoices?|receipts?)\b/i.test(operator);
}

export function withInvoiceTurnContract(
  systemInstruction: string | undefined,
  query: string,
): string | undefined {
  if (!operatorRequestsInvoice(query)) return systemInstruction;
  const base = systemInstruction?.trim() ?? "";
  if (base.includes("THIS TURN IS AN INVOICE REQUEST")) return base || undefined;
  return base ? `${base}\n\n${INVOICE_TURN_CONTRACT}` : INVOICE_TURN_CONTRACT;
}

export function loadOrgCraftSystemInstruction(opts: OrgCraftLoadOptions): string | undefined {
  if (!opts.enabled) return undefined;

  const inline = opts.inlineInstruction?.trim();
  if (inline) {
    if (PII_KEY_RE.test(inline)) return undefined;
    return ensureInvoicePlaybook(inline);
  }

  if (opts.filePath) {
    try {
      const read = opts.readFileSync ?? defaultReadFileSync;
      const raw = read(opts.filePath, "utf8");
      const parsed = parsePlaybooks(JSON.parse(raw));
      if (parsed.length) {
        const formatted = formatCraftSystemInstruction(parsed);
        if (formatted) return ensureInvoicePlaybook(formatted);
      }
    } catch {
      // Fall through to the bundled pack.
    }
  }

  if (opts.useDefaults === false) return undefined;
  const formatted = formatCraftSystemInstruction(DEFAULT_CRAFT_PLAYBOOKS);
  return formatted ? ensureInvoicePlaybook(formatted) : undefined;
}
