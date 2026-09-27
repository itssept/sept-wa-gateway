/**
 * Outbound message sanitization for Baileys WhatsApp transport.
 * 
 * Rules:
 * - Operating Rule 40 & Agent Brain 29:
 *   "Before any WhatsApp-facing response, remove every 'Teach SEPT' link or footer,
 *    all PromptQL/internal platform links and language, all `ql.app/l/` links,
 *    and any wiki, artifact, code, automation, database, or developer wording.
 *    Keep only the concierge/client content and native file attachments."
 * 
 * Acceptance criteria:
 * 1. Outbound messages containing forbidden patterns are delivered clean.
 * 2. Stripped patterns:
 *    - "Teach SEPT" links / footers (e.g. `🧠 Teach SEPT → https://ql.app/l/...`, `Teach SEPT: ...`, `[Teach SEPT](...)`)
 *    - All `ql.app/l/...` and `https://ql.app/...` links
 *    - Internal platform URLs (e.g. `https://prompt.ql.app/...`, `thread://...`, `wiki://...`, `wiki-promptql://...`, `artifact://...`)
 *    - XML/platform tags (e.g. `<artifact .../>`, `<file_reference .../>`, `<user_mention .../>`, `<agent_mention/>`, `<cite>...</cite>`)
 *    - Markdown wiki links like `[Title](<wiki://...>)` -> cleaned to plain text `Title` or stripped
 *    - Platform/developer meta-language / footers
 * 3. Legitimate client-facing URLs (e.g. `https://instagram.com/...`, `https://dhl.com/track/...`, `https://stripe.com/...`, `https://chanel.com/...`) MUST NOT be stripped.
 * 4. The welcome template from Bot 1 passes unchanged.
 */

/**
 * Strips all internal platform links, ql.app links, Teach SEPT footers,
 * and platform artifacts/syntax from outbound text destined for WhatsApp.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // 1. Remove citations (<cite>...</cite>) completely since citations are internal metadata
  cleaned = cleaned.replace(/<cite>[\s\S]*?<\/cite>/gi, "");

  // 2. Remove "Teach SEPT" markdown links and footers
  // [Teach SEPT](...)
  cleaned = cleaned.replace(/\[\s*(?:🧠\s*)?Teach\s+SEPT\s*\]\([^\)]*\)/gi, "");
  // Plain or emoji Teach SEPT lines / phrases
  cleaned = cleaned.replace(/(?:🧠\s*)?Teach\s+SEPT(?:\s*[-–—→>:]+\s*|\s+)(?:https?:\/\/[^\s\)]+|[^\n]+)?/gi, "");
  cleaned = cleaned.replace(/(?:🧠\s*)?Teach\s+SEPT\b/gi, "");

  // 3. Remove any remaining ql.app links (both ql.app/l/... permalinks and prompt.ql.app / other subdomains)
  cleaned = cleaned.replace(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?ql\.app[^\s\)\]]*/gi, "");

  // 4. Remove thread://, wiki://, wiki-promptql://, artifact://, federated-wiki:// custom URI schemes
  // Handles markdown format [Text](<wiki://...>) -> converts to "Text" if non-empty, or removes
  cleaned = cleaned.replace(/\[([^\]]+)\]\(\s*<[^>]+>\s*\)/g, "$1");
  cleaned = cleaned.replace(/\[([^\]]+)\]\(\s*(?:wiki|wiki-promptql|federated-wiki|thread|artifact):\/\/[^\s\)]+\)/g, "$1");
  cleaned = cleaned.replace(/<(?:wiki|wiki-promptql|federated-wiki|thread|artifact):\/\/[^>]+>/gi, "");
  cleaned = cleaned.replace(/(?:wiki|wiki-promptql|federated-wiki|thread|artifact):\/\/[^\s\)]+/gi, "");

  // 5. Remove leftover XML platform tags like <artifact ... />, <file_reference ... />, <user_mention ... />, <agent_mention />, <room_reference ... />
  cleaned = cleaned.replace(/<(?:artifact|file_reference|user_mention|user_group_mention|agent_mention|room_reference|wiki_page_reference|thread_reference|connect_integration|connect_data_source|cite)[^>]*\/>/gi, "");
  cleaned = cleaned.replace(/<\/?(?:artifact|file_reference|user_mention|user_group_mention|agent_mention|room_reference|wiki_page_reference|thread_reference|connect_integration|connect_data_source|cite)[^>]*>/gi, "");

  // 6. Clean up any trailing/empty markdown links that might be left: e.g. "[]()" or "[ ]( )" or "[](https://...)"
  cleaned = cleaned.replace(/\[\s*\]\([^\)]*\)/g, "");

  // 7. Clean up empty/dangling lines and normalize whitespace
  const lines = cleaned.split("\n");
  const filteredLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Drop lines that are purely punctuation or leftover label markers with nothing after (e.g. "Invoice Link:", "User Mention:")
    if (/^[-–—→>:\s]+$/.test(trimmed)) {
      continue;
    }
    // Drop lines that end up with only a dangling colon/header after URL removal if it was an internal marker
    if (/^(?:invoice link|internal console|user mention|artifact tag)\s*:\s*$/i.test(trimmed)) {
      continue;
    }
    filteredLines.push(line);
  }

  cleaned = filteredLines.join("\n");
  // Normalize 3+ newlines to 2 newlines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}