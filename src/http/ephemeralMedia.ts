/**
 * Short-lived, token-gated media bridge for PromptQL fetch-fallback when
 * ask_promptql.files staging returns upload_failed.
 *
 * Tokens are unguessable; entries expire. Bridge puts are multi-fetch within
 * TTL (PromptQL may HEAD then GET, or retry). Possession of the token is the
 * credential — served without admin auth.
 */

import { randomBytes } from "node:crypto";

export interface EphemeralMediaEntry {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  expiresAtMs: number;
  /** Remaining successful GET body deliveries. null = unlimited until TTL. */
  remainingFetches: number | null;
}

export interface EphemeralPutInput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  /** Default 15 minutes. */
  ttlMs?: number;
  /**
   * Max successful body deliveries before the token is burned.
   * Default 8 (PromptQL often probes then fetches; single-use burned the bytes).
   * Set 1 for legacy single-use. Unlimited GETs until TTL: pass unlimitedFetches.
   */
  maxFetches?: number;
  /** When true, ignore maxFetches and allow unlimited GETs until TTL. */
  unlimitedFetches?: boolean;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FETCHES = 8;
const MAX_ENTRIES = 64;

export class EphemeralMediaStore {
  private readonly entries = new Map<string, EphemeralMediaEntry>();

  put(input: EphemeralPutInput): string {
    this.gc();
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
    const token = randomBytes(24).toString("hex");
    const remainingFetches = input.unlimitedFetches
      ? null
      : Math.max(1, input.maxFetches ?? DEFAULT_MAX_FETCHES);
    this.entries.set(token, {
      bytes: Buffer.from(input.bytes),
      mimeType: input.mimeType,
      fileName: input.fileName,
      expiresAtMs: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
      remainingFetches,
    });
    return token;
  }

  /** Metadata-only; does not burn a fetch. */
  peek(token: string): EphemeralMediaEntry | null {
    this.gc();
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    return entry;
  }

  take(token: string): EphemeralMediaEntry | null {
    this.gc();
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    if (entry.remainingFetches == null) {
      return entry;
    }
    if (entry.remainingFetches <= 0) {
      this.entries.delete(token);
      return null;
    }
    entry.remainingFetches -= 1;
    if (entry.remainingFetches <= 0) this.entries.delete(token);
    return entry;
  }

  /** Test helper. */
  size(): number {
    this.gc();
    return this.entries.size;
  }

  private gc(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(token);
    }
  }
}

/** Build the public URL PromptQL should fetch. */
export function ephemeralMediaUrl(publicBaseUrl: string, token: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/api/v1/ephemeral-media/${token}`;
}

export function isEphemeralMediaPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/v1\/ephemeral-media\/([a-f0-9]{48})$/);
  return m?.[1] ?? null;
}

/**
 * Warn when the public base uses a non-standard port. PromptQL Cloud egress
 * often allows :80/:443 but not :8790 — prefer Caddy (or TLS) on standard ports.
 */
export function publicBaseUrlUsesNonStandardPort(publicBaseUrl: string): boolean {
  try {
    const u = new URL(publicBaseUrl);
    if (!u.port) return false; // scheme default 80/443
    const n = Number(u.port);
    return n !== 80 && n !== 443;
  } catch {
    return false;
  }
}

/** Header-safe Content-Type. Reject anything that is not a single type/subtype. */
export function safeContentType(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : "application/octet-stream";
}

/** Header-safe inline disposition. The token is the credential; the name is not. */
export function contentDispositionInline(fileName: string): string {
  const safe = fileName.replace(/[^\w.\- ()]/g, "_").replace(/_+/g, "_").slice(0, 180) || "photo";
  return `inline; filename="${safe}"`;
}
