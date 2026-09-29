/**
 * Prepare WhatsApp media for ask_promptql.files.
 *
 * Live 2026-09-29: PromptQL MCP staging returns upload_failed for some
 * operator images even when gateway DNS and Baileys download succeed.
 * Normalizing mime/filename and recompressing large JPEGs improves the
 * chance the staging path accepts the payload before we fall back to the
 * ephemeral media bridge.
 */

import jpeg from "jpeg-js";
import type { PromptQlFileInput } from "./promptqlAdapter.ts";

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** Target max decoded bytes after recompress (leaves headroom under MCP 10 MiB). */
const RECOMPRESS_MAX_BYTES = 900 * 1024;
const RECOMPRESS_MAX_EDGE = 1600;

export function baseMime(mime: string | null | undefined): string {
  const raw = (mime ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  return raw;
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
  };
  return map[mime] ?? "";
}

function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function ensureFileName(name: string, mime: string): string {
  const trimmed = name.trim().slice(0, 255) || "whatsapp-media";
  const ext = extensionForMime(mime);
  if (!ext) return trimmed;
  if (trimmed.toLowerCase().endsWith(ext)) return trimmed;
  // Drop a mismatched extension before appending the correct one.
  const without = trimmed.replace(/\.[a-z0-9]{1,8}$/i, "");
  return `${without || "whatsapp-media"}${ext}`.slice(0, 255);
}

/** Strip mime parameters, align filename extension, prefer sniffed image mime. */
export function normalizePromptQlFile(file: PromptQlFileInput): PromptQlFileInput {
  const bytes = Buffer.from(file.content_base64, "base64");
  const sniffed = sniffImageMime(bytes);
  let mime = baseMime(file.mime_type);
  if (sniffed && (mime === "application/octet-stream" || mime.startsWith("image/"))) {
    mime = sniffed;
  }
  return {
    file_name: ensureFileName(file.file_name, mime),
    mime_type: mime,
    content_base64: file.content_base64,
  };
}

function scaleDims(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Nearest-neighbor resize of raw RGBA. */
function resizeRgba(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}

/**
 * Recompress image/jpeg payloads that exceed RECOMPRESS_MAX_BYTES.
 * Non-JPEG images and small JPEGs are returned unchanged (still normalized).
 * Failures fall back to the normalized original — never throw.
 */
export function recompressPromptQlFile(file: PromptQlFileInput): PromptQlFileInput {
  const normalized = normalizePromptQlFile(file);
  if (normalized.mime_type !== "image/jpeg") return normalized;
  const bytes = Buffer.from(normalized.content_base64, "base64");
  if (bytes.length <= RECOMPRESS_MAX_BYTES) return normalized;
  try {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    if (!decoded?.data || !decoded.width || !decoded.height) return normalized;
    let best: Buffer | null = null;
    for (const maxEdge of [RECOMPRESS_MAX_EDGE, 1280, 1024, 800]) {
      const { width, height } = scaleDims(decoded.width, decoded.height, maxEdge);
      const rgba = width === decoded.width && height === decoded.height
        ? decoded.data
        : resizeRgba(decoded.data as Uint8Array, decoded.width, decoded.height, width, height);
      for (const quality of [75, 60, 45, 35]) {
        const encoded = jpeg.encode({ data: rgba, width, height }, quality);
        if (!encoded?.data?.length) continue;
        const out = Buffer.from(encoded.data);
        if (!best || out.length < best.length) best = out;
        if (out.length <= RECOMPRESS_MAX_BYTES && out.length < bytes.length) {
          return {
            file_name: ensureFileName(normalized.file_name, "image/jpeg"),
            mime_type: "image/jpeg",
            content_base64: out.toString("base64"),
          };
        }
      }
    }
    if (best && best.length < bytes.length) {
      return {
        file_name: ensureFileName(normalized.file_name, "image/jpeg"),
        mime_type: "image/jpeg",
        content_base64: best.toString("base64"),
      };
    }
    return normalized;
  } catch {
    return normalized;
  }
}

export function isImagePromptQlFile(file: PromptQlFileInput): boolean {
  return IMAGE_MIME.has(baseMime(file.mime_type));
}

export function promptQlFileMeta(file: PromptQlFileInput): {
  mime: string;
  fileNameLen: number;
  bytes: number;
  base64Len: number;
} {
  return {
    mime: baseMime(file.mime_type),
    fileNameLen: file.file_name.length,
    bytes: Buffer.byteLength(file.content_base64, "base64"),
    base64Len: file.content_base64.length,
  };
}
