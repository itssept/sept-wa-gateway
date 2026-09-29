/**
 * Short-lived, token-gated media bridge for PromptQL fetch-fallback when
 * ask_promptql.files staging returns upload_failed.
 *
 * Tokens are unguessable; entries expire and are single-use by default.
 * Served without admin auth — possession of the token is the credential.
 */

import { randomBytes } from "node:crypto";

export interface EphemeralMediaEntry {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  expiresAtMs: number;
  singleUse: boolean;
}

export interface EphemeralPutInput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  /** Default 15 minutes. */
  ttlMs?: number;
  singleUse?: boolean;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
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
    this.entries.set(token, {
      bytes: Buffer.from(input.bytes),
      mimeType: input.mimeType,
      fileName: input.fileName,
      expiresAtMs: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
      singleUse: input.singleUse !== false,
    });
    return token;
  }

  take(token: string): EphemeralMediaEntry | null {
    this.gc();
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    if (entry.singleUse) this.entries.delete(token);
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
