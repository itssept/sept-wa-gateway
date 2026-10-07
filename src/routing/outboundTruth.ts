/**
 * Drop outbound claims the agent cannot make true.
 *
 * Live 2026-10-07: after a voice-note approval expired, the agent told the
 * WhatsApp chat it was "Setting all background approvals to auto-approve".
 * PromptQL approval settings are not something this gateway or the agent
 * can change from chat. Those sentences are removed. Ordinary status
 * ("for your approval", "was not auto-approved", "cannot change approval
 * settings") stays.
 */

const AUTO_APPROVE = /\bauto[-\s]?approv(?:e|es|ed|ing|al|als)\b/i;
const NEGATION =
  /\b(?:not|never|cannot|can't|can’t|won't|won’t|without|don't|do not|did not|didn't|unable)\b/i;
const ADMIN_OBJECT =
  /\b(?:background\s+approvals?|approval\s+settings?|background\s+permissions?|approval\s+gates?|platform\s+(?:approvals?|permissions?|settings?)|promptql\s+(?:approvals?|permissions?|settings?))\b/i;
const MUTATION =
  /\b(?:set(?:ting)?|enable[ds]?|disabl(?:e|ed|ing)|turn(?:ing|ed)?|switch(?:ing|ed)?|chang(?:e|ed|ing)|updat(?:e|ed|ing)|bypass(?:ed|ing)?|grant(?:ed|ing)?|configur(?:e|ed|ing))\b/i;
const STATE_CHANGE =
  /\b(?:are|is|were|was|now|been)\b/i;
const STATE_WORD = /\b(?:enabled|disabled|automatic|granted)\b/i;

/** True when this sentence claims an admin/approval change the agent cannot perform. */
export function isUnperformableAdminClaim(sentence: string): boolean {
  const text = sentence.trim();
  if (!text) return false;
  const auto = AUTO_APPROVE.test(text);
  const negated = NEGATION.test(text);
  if (auto) return !negated;
  if (!ADMIN_OBJECT.test(text)) return false;
  if (negated) return false;
  if (MUTATION.test(text)) return true;
  if (STATE_CHANGE.test(text) && STATE_WORD.test(text)) return true;
  return false;
}

/**
 * Remove false admin-action sentences. A message that is only that claim
 * becomes empty so the caller sends nothing.
 */
export function stripUnperformableAdminClaims(text: string): string {
  if (!text) return "";
  const paragraphs = text.split(/\n{2,}/);
  const kept = paragraphs.map((paragraph) => {
    const lines = paragraph.split("\n").map((line) => {
      const sentences = line.split(/(?<=[.!?])\s+/);
      return sentences
        .filter((sentence) => sentence.trim() && !isUnperformableAdminClaim(sentence))
        .join(" ");
    }).filter((line) => line.trim().length > 0);
    return lines.join("\n");
  }).filter((paragraph) => paragraph.trim().length > 0);
  return kept.join("\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
