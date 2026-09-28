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
 *    - All `ql.app/l/...` and `https://ql.app/...` links, including schemeless
 *      permalinks and any `*.ql.app` host (`prompt.ql.app`, `data.prompt.ql.app`)
 *    - Internal platform URLs (e.g. `https://prompt.ql.app/...`, `thread://...`, `wiki://...`, `wiki-promptql://...`, `artifact://...`)
 *    - PromptQL lifecycle banners (`run was cancelled before it could finish`,
 *      `interrupted_due_to_new_trigger`) and labeled run/thread ids
 *    - XML/platform tags (e.g. `<artifact .../>`, `<file_reference .../>`, `<user_mention .../>`, `<agent_mention/>`, `<cite>...</cite>`)
 *    - Markdown wiki links like `[Title](<wiki://...>)` -> cleaned to plain text `Title` or stripped
 *    - Platform/developer meta-language / footers
 *    - WhatsApp does not render Markdown. Headers, emphasis markers, fenced
 *      blocks, and inline code spans are removed; the words stay.
 * 3. Legitimate client-facing URLs (e.g. `https://instagram.com/...`, `https://dhl.com/track/...`, `https://stripe.com/...`, `https://chanel.com/...`) MUST NOT be stripped.
 * 4. The welcome template from Bot 1 passes unchanged (its `*` bullets are list
 *    markers, not emphasis).
 *
 * Document captions are a separate, shorter cut of that plain text. The file
 * holds the invoice detail; the caption is the lead-in.
 */

/** Preferred length for a document caption. WhatsApp shows only a few lines under a file. */
const DOCUMENT_CAPTION_MAX_CHARS = 320;
const DOCUMENT_CAPTION_MAX_LINES = 4;
/** WhatsApp drops or rejects a caption longer than this. */
const WHATSAPP_CAPTION_HARD_MAX = 1024;

const FAILURE_NOTE_RE = /\n\n(\((?:Attachment|\d+ attachments)[^)\n]*\))$/;

/** PromptQL system-banner phrasing. Not client copy about a cancelled order. */
const LIFECYCLE_SIGNAL =
  /interrupted_due_to_new_trigger|\brun (?:was |has been )?cancell?ed before it could finish\b|\u26A0\uFE0F?[^\n]{0,80}\brun was cancell?ed\b|SEPT['’]?s\s+run\s+was\s+cancell?ed|PromptQL\s+run\s+(?:was\s+)?cancell?ed|(?:^|\n)\s*(?:status|run status|error|reason)\s*:\s*(?:failed|error|cancell?ed|canceled|interrupted)\b/i;

const SAFE_FAILURE_REASONS = new Set([
  "interrupted_due_to_new_trigger",
  "promptql_run_failed",
  "lifecycle_notice",
  "promptql_error",
  "empty response",
  "chat_left",
  "PromptQL did not respond before the deadline.",
]);

/**
 * Strips all internal platform links, ql.app links, Teach SEPT footers,
 * lifecycle/cancel banners, run ids, and platform artifacts/syntax from
 * outbound text destined for WhatsApp.
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

  // 3. Internal hosts: ql.app, prompt.ql.app, data.prompt.ql.app, with or without a scheme.
  //    Markdown links to those hosts are removed entirely (the label is platform chrome).
  //    A single optional subdomain is not enough — live permalinks and console URLs use
  //    both bare ql.app/l/... and multi-level *.ql.app hosts.
  cleaned = cleaned.replace(/\[[^\]\n]*\]\(\s*[^)\n]*ql\.app[^)\n]*\)/gi, "");
  cleaned = cleaned.replace(
    /(?<![\w.])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*ql\.app(?:\/[^\s)\]>]*)?/gi,
    "",
  );
  cleaned = stripRunIdentifiers(cleaned);
  cleaned = stripLifecycleCopy(cleaned);

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
  // A label whose internal URL was already removed, e.g. "[View run]()".
  cleaned = cleaned.replace(/\[[^\]\n]*\]\(\s*\)/g, "");

  // 7. WhatsApp renders none of this. Keep the words; drop the syntax.
  cleaned = stripWhatsAppMarkdown(cleaned);

  // 8. Clean up empty/dangling lines and normalize whitespace
  const lines = cleaned.split("\n");
  const filteredLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const bare = trimmed.replace(/\uFE0F/g, "");
    // Drop lines that are purely punctuation, a leftover warning mark, or empty brackets.
    // Empty lines stay — they separate paragraphs in the welcome template.
    if (bare.length > 0 && /^[-–—→>:.\s⚠❗()[\]<>*#|~_]+$/.test(bare)) {
      continue;
    }
    // Drop lines that end up with only a dangling colon/header after URL removal if it was an internal marker
    if (/^(?:invoice link|internal console|user mention|artifact tag|run id|thread id|thread event id|run_id|thread_id|thread_event_id)\s*:?\s*$/i.test(trimmed)) {
      continue;
    }
    filteredLines.push(line);
  }

  cleaned = filteredLines.join("\n");
  // Normalize 3+ newlines to 2 newlines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

/**
 * Plain-text caption for a document send. Long replies (invoice field dumps)
 * are cut to the opening lines — the PDF already carries the detail. A
 * preserved prefix (the operator welcome) is kept whole. A failure note in
 * brackets stays on the end.
 */
export function documentCaption(text: string, preservedPrefix?: string): string {
  const { body, note } = splitFailureNote(text.trim());
  const prefix = preservedPrefix?.trim() ?? "";
  let shortBody: string;
  if (prefix && (body === prefix || body.startsWith(`${prefix}\n`))) {
    const rest = body.slice(prefix.length).trim();
    const shortRest = shortenCaptionBody(rest);
    shortBody = shortRest ? `${prefix}\n\n${shortRest}` : prefix;
  } else {
    shortBody = shortenCaptionBody(body);
  }
  const withNote = note ? (shortBody ? `${shortBody}\n\n${note}` : note) : shortBody;
  if (withNote.length <= WHATSAPP_CAPTION_HARD_MAX) return withNote;
  if (!note) return clipAtBoundary(withNote, WHATSAPP_CAPTION_HARD_MAX);
  const room = WHATSAPP_CAPTION_HARD_MAX - (note.length + 2);
  if (room < 1) return note.slice(0, WHATSAPP_CAPTION_HARD_MAX);
  const clipped = clipAtBoundary(shortBody, room);
  return clipped ? `${clipped}\n\n${note}` : note;
}

/**
 * True when the text is a PromptQL system banner (cancel / interrupt / status)
 * with no concierge content left to send. Callers drop these instead of
 * forwarding the banner or its permalinks.
 */
export function isLifecycleOnlyOutbound(text: string): boolean {
  if (!text.trim() || !LIFECYCLE_SIGNAL.test(text)) return false;
  return sanitizeOutboundText(text).trim() === "";
}

/**
 * Reason string safe to log. Server cancel copy and internal URLs never
 * become the logged reason — the failed path does not run the WhatsApp
 * sanitizer, so this is the gate for that string.
 */
export function outboundFailureReason(message: string): string {
  const trimmed = message.trim();
  if (SAFE_FAILURE_REASONS.has(trimmed)) return trimmed;
  if (/interrupted_due_to_new_trigger/i.test(trimmed)) return "interrupted_due_to_new_trigger";
  if (isLifecycleOnlyOutbound(trimmed) || LIFECYCLE_SIGNAL.test(trimmed)) return "lifecycle_notice";
  if (/ql\.app/i.test(trimmed)) return "promptql_run_failed";
  if (trimmed.startsWith("PromptQL error:") || trimmed.startsWith("PromptQL run ")) {
    return "promptql_run_failed";
  }
  if (trimmed.length > 100) return "promptql_run_failed";
  return trimmed;
}

function stripRunIdentifiers(text: string): string {
  return text
    .replace(
      /\b(?:run_id|thread_id|thread_event_id|run id|thread id|thread event id)\s*[:=#]?\s*[A-Za-z0-9_-]{6,}\b/gi,
      "",
    )
    .replace(/\brun_[A-Za-z0-9]{8,}\b/g, "");
}

/**
 * Remove system cancellation copy. Sentences are matched so a real reply that
 * merely mentions a cancelled shipment is kept; the PromptQL banner
 * ("run was cancelled before it could finish") is not.
 */
function stripLifecycleCopy(text: string): string {
  return text
    .replace(/[^\n]*interrupted_due_to_new_trigger[^\n]*/gi, "")
    // SEPT / PromptQL cancelled-run notices. Straight or curly apostrophe.
    // "PromptQL run was cancelled." has no "before it could finish" clause.
    .replace(/\u26A0\uFE0F?\s*SEPT['’]?s\s+run\s+was\s+cancell?ed[^\n.]*(?:\.|!)?/gi, "")
    .replace(/SEPT['’]?s\s+run\s+was\s+cancell?ed\s+before\s+it\s+could\s+finish\.?/gi, "")
    .replace(/PromptQL\s+run\s+(?:was\s+)?cancell?ed[^\n.]*(?:\.|!)?/gi, "")
    .replace(/[^\n.!?]*\brun (?:was |has been )?cancell?ed before it could finish\b[^\n.!?]*/gi, "")
    .replace(/^[ \t]*\u26A0\uFE0F?[^\n]*\brun was cancell?ed\b[^\n]*$/gim, "")
    .replace(
      /^(?:[ \t]*\u26A0\uFE0F?\s*)?(?:status|run status|error|reason)\s*:\s*(?:failed|error|cancell?ed|canceled|interrupted|interrupted_due_to_new_trigger)\b[^\n]*$/gim,
      "",
    );
}

/**
 * Remove Markdown syntax WhatsApp would show literally. List markers (`* item`)
 * stay — the welcome template uses them as bullets. Paired emphasis
 * (`*bold*`, `**bold**`, `_italic_`) does not.
 */
function stripWhatsAppMarkdown(text: string): string {
  let cleaned = text;
  // Closed fences first, then a leftover opener/closer line. Body text stays.
  cleaned = cleaned.replace(
    /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]{0,3}\2[ \t]*(?=\n|$)/g,
    (_match, lead: string, _fence: string, body: string) => `${lead}${body.replace(/\n$/, "")}`,
  );
  cleaned = cleaned.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm, "");
  // Longer backtick spans before single ones, so ``code`` is not eaten as `code`.
  cleaned = cleaned.replace(/(?<!`)``([^`\n]+)``(?!`)/g, "$1");
  cleaned = cleaned.replace(/(?<!`)`([^`\n]+)`(?!`)/g, "$1");
  // ATX headers. A bare "Order #123" is not a header (no space-separated marker at column 0).
  cleaned = cleaned.replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, "");
  cleaned = cleaned.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1");
  // Horizontal rules.
  cleaned = cleaned.replace(/^[ \t]{0,3}(?:[-*_]){3,}[ \t]*$/gm, "");
  cleaned = stripEmphasis(cleaned);
  // Remaining markdown links read as the label plus the URL.
  cleaned = cleaned.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
  cleaned = cleaned.replace(/\[([^\]\n]+)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g, "$1 ($2)");
  return cleaned;
}

function stripEmphasis(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = current
      .replace(/(?<![\w*])\*\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*\*(?![\w*])/g, "$1")
      .replace(/(?<![\w*])\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?![\w*])/g, "$1")
      .replace(/(?<![\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w_])___([^\s_](?:[^_\n]*?[^\s_])?)___(?![\w_])/g, "$1")
      .replace(/(?<![\w_])__([^\s_](?:[^_\n]*?[^\s_])?)__(?![\w_])/g, "$1")
      .replace(/(?<![\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])/g, "$1")
      .replace(/(?<!~)~~([^\s~](?:[^~\n]*?[^\s~])?)~~(?!~)/g, "$1");
    if (next === current) return current;
    current = next;
  }
  return current;
}

function splitFailureNote(text: string): { body: string; note: string | null } {
  const match = text.match(FAILURE_NOTE_RE);
  if (!match || match.index == null) return { body: text, note: null };
  return { body: text.slice(0, match.index).trim(), note: match[1] ?? null };
}

function shortenCaptionBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const nonEmpty = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (trimmed.length <= DOCUMENT_CAPTION_MAX_CHARS && nonEmpty.length <= DOCUMENT_CAPTION_MAX_LINES) {
    return trimmed;
  }
  const kept: string[] = [];
  let count = 0;
  for (const line of trimmed.split("\n")) {
    if (line.trim().length === 0) {
      if (count > 0 && count < DOCUMENT_CAPTION_MAX_LINES) kept.push("");
      continue;
    }
    if (count >= DOCUMENT_CAPTION_MAX_LINES) break;
    kept.push(line.trimEnd());
    count++;
  }
  let result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (result.length > DOCUMENT_CAPTION_MAX_CHARS) result = clipAtBoundary(result, DOCUMENT_CAPTION_MAX_CHARS);
  return result;
}

function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  let lastSentenceEnd = -1;
  const sentenceEnd = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(slice))) lastSentenceEnd = match.index + 1;
  if (lastSentenceEnd >= 40) return slice.slice(0, lastSentenceEnd).trim();
  const word = slice.replace(/\s+\S*$/, "").trim();
  return word.length >= 40 ? word : slice.trim();
}