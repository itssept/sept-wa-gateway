/**
 * AES-256-GCM encrypt/decrypt under DATA_ENCRYPTION_KEY, plus small credential
 * helpers (constant-time compare, one-way hash).
 *
 * Used to encrypt at rest:
 *   - Baileys session/creds blobs (src/whatsapp/authState.ts)
 *   - per-shopper MCP service-account tokens (src/storage/credentialStore.ts)
 *
 * Envelope layout is a single Buffer:
 *     [ 12-byte IV ][ 16-byte GCM auth tag ][ ciphertext ... ]
 * so a decrypt needs only the key + the stored BLOB.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";

const IV_LEN = 12; // 96-bit nonce, GCM standard
const TAG_LEN = 16;
const ALGO = "aes-256-gcm";

export function encrypt(plaintext: Buffer | string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const data =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(envelope: Buffer, key: Buffer): Buffer {
  if (envelope.length < IV_LEN + TAG_LEN) {
    throw new Error("Ciphertext envelope too short / corrupt.");
  }
  const iv = envelope.subarray(0, IV_LEN);
  const tag = envelope.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = envelope.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function decryptToString(envelope: Buffer, key: Buffer): string {
  return decrypt(envelope, key).toString("utf8");
}

/**
 * Constant-time string equality for shared secrets (admin token compare).
 * Hash both sides first so the compare is over equal-length digests and never
 * leaks the secret length via early return.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** One-way SHA-256 hex digest — used to store a non-reversible fingerprint of a
 *  secret for audit/lookup without keeping the secret itself. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
