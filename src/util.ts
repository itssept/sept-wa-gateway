/**
 * Small shared helpers: jid parsing, E.164 normalization, ids, time, log masking.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** WhatsApp DM jids look like `<number>@s.whatsapp.net`; groups `<id>@g.us`. */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function isDmJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

/**
 * Opaque WhatsApp LID jids look like `<id>@lid`. A LID carries NO phone number,
 * so it cannot be normalized as if its digits were a phone.
 */
export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

/** Strip the domain part of a jid, and any device/agent suffix (`:<n>`). */
export function jidUser(jid: string): string {
  const at = jid.indexOf("@");
  const user = at === -1 ? jid : jid.slice(0, at);
  const colon = user.indexOf(":");
  return colon === -1 ? user : user.slice(0, colon);
}

/**
 * Best-effort E.164 from a phone-bearing jid. Returns null for non-phone jids
 * (group jids, @lid).
 */
export function phoneE164FromJid(jid: string): string | null {
  if (!isDmJid(jid)) return null;
  const user = jidUser(jid);
  if (!/^\d{6,15}$/.test(user)) return null;
  return `+${user}`;
}

/** E.164 number (with or without leading +) → the bare digits Baileys wants. */
export function e164ToPairingNumber(e164: string): string {
  return e164.replace(/[^\d]/g, "");
}

/**
 * Canonicalize a user-supplied phone string to ONE E.164 representation
 * `+<6-15 digits>`, or null when it isn't a valid phone. Equivalent inputs
 * (`+14155551212`, `14155551212`, `+1 (415) 555-1212`) collapse to one value.
 */
export function canonicalizeE164(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  if (!/^\d{6,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Mask a phone/E.164 for logs — keep only the last 4 digits. */
export function maskNumber(e164: string | null | undefined): string {
  if (!e164) return "?";
  const digits = e164.replace(/[^\d]/g, "");
  return digits.length <= 4 ? "***" : `***${digits.slice(-4)}`;
}

/** Mask a jid (phone or @lid) for logs — last 4 of the user part + domain. */
export function maskJid(jid: string | null | undefined): string {
  if (!jid) return "?";
  const at = jid.indexOf("@");
  const user = at === -1 ? jid : jid.slice(0, at);
  const domain = at === -1 ? "" : jid.slice(at);
  const tail = user.length <= 4 ? "***" : `***${user.slice(-4)}`;
  return `${tail}${domain}`;
}

/** Mask any secret/token for logs — never print more than a short prefix. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return "?";
  return secret.length <= 6 ? "***" : `${secret.slice(0, 3)}***`;
}

/** Construct a DM jid from an E.164 number. */
export function e164ToJid(e164: string): string {
  return `${e164ToPairingNumber(e164)}@s.whatsapp.net`;
}
