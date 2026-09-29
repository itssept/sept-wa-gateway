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

export function loadOrgCraftSystemInstruction(opts: OrgCraftLoadOptions): string | undefined {
  if (!opts.enabled) return undefined;

  const inline = opts.inlineInstruction?.trim();
  if (inline) {
    if (PII_KEY_RE.test(inline)) return undefined;
    return inline;
  }

  if (opts.filePath) {
    try {
      const read = opts.readFileSync ?? defaultReadFileSync;
      const raw = read(opts.filePath, "utf8");
      const parsed = parsePlaybooks(JSON.parse(raw));
      if (parsed.length) {
        const formatted = formatCraftSystemInstruction(parsed);
        return formatted || undefined;
      }
    } catch {
      // Fall through to the bundled pack.
    }
  }

  if (opts.useDefaults === false) return undefined;
  const formatted = formatCraftSystemInstruction(DEFAULT_CRAFT_PLAYBOOKS);
  return formatted || undefined;
}
