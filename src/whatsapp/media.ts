/**
 * Download WhatsApp media into bounded, transient memory before its CDN URL
 * expires. The bytes are handed directly to PromptQL and are never persisted.
 */

import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import type { Logger } from "../logger.ts";

export type MediaStatus =
  | "none"
  | "ready"
  | "failed"
  | "expired"
  | "too_large";

export interface DownloadedMedia {
  bytes: Buffer;
  mime: string | undefined;
  sizeBytes: number;
}

const MEDIA_TYPES = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
] as const;

const MESSAGE_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
];

export function hasMedia(message: WAMessage): boolean {
  const content = message.message as Record<string, unknown> | null | undefined;
  return Boolean(content && MEDIA_TYPES.some((type) => Boolean(content[type])));
}

export function classifyMessage(message: WAMessage): string {
  const content = message.message as Record<string, unknown> | null | undefined;
  if (!content) return "unknown";
  for (const [field, type] of MESSAGE_TYPES) {
    if (content[field]) return type;
  }
  return content.conversation || content.extendedTextMessage ? "text" : "unknown";
}

function mediaMime(message: WAMessage): string | undefined {
  const content = message.message as Record<string, unknown> | null | undefined;
  if (!content) return undefined;
  for (const type of MEDIA_TYPES) {
    const node = content[type] as { mimetype?: string } | undefined;
    if (node?.mimetype) return node.mimetype;
  }
  return undefined;
}

function mediaFileLength(message: WAMessage): number | null {
  const content = message.message as Record<string, unknown> | null | undefined;
  if (!content) return null;
  for (const type of MEDIA_TYPES) {
    const node = content[type] as
      | { fileLength?: number | string | { toNumber?: () => number } }
      | undefined;
    const length = node?.fileLength;
    if (length == null) continue;
    if (typeof length === "number") return length;
    if (typeof length === "string") {
      const parsed = Number(length);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof length.toNumber === "function") return length.toNumber();
  }
  return null;
}

interface BaileysLogger {
  level: string;
  child(fields: Record<string, unknown>): BaileysLogger;
  trace(fields: unknown, message?: string): void;
  debug(fields: unknown, message?: string): void;
  info(fields: unknown, message?: string): void;
  warn(fields: unknown, message?: string): void;
  error(fields: unknown, message?: string): void;
}

function baileysLogger(): BaileysLogger {
  const adapter: BaileysLogger = {
    level: "silent",
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => adapter,
  };
  return adapter;
}

type DownloadImplementation = (
  message: WAMessage,
  socket: Pick<WASocket, "updateMediaMessage">,
) => Promise<AsyncIterable<Uint8Array> & { destroy?: () => void }>;

async function defaultDownload(
  message: WAMessage,
  socket: Pick<WASocket, "updateMediaMessage">,
): Promise<AsyncIterable<Uint8Array> & { destroy?: () => void }> {
  return (await downloadMediaMessage(
    message,
    "stream",
    {},
    {
      logger: baileysLogger(),
      reuploadRequest: socket.updateMediaMessage,
    },
  )) as unknown as AsyncIterable<Uint8Array> & { destroy?: () => void };
}

export class TransientMediaDownloader {
  constructor(
    private readonly maxBytes: number,
    private readonly log: Logger,
    private readonly implementation?: DownloadImplementation,
  ) {}

  async download(
    message: WAMessage,
    socket: Pick<WASocket, "updateMediaMessage">,
  ): Promise<{ status: MediaStatus; media: DownloadedMedia | null }> {
    if (!hasMedia(message)) return { status: "none", media: null };

    const declared = mediaFileLength(message);
    if (declared != null && declared > this.maxBytes) {
      this.log.warn("media skipped: declared size exceeds limit", {
        declaredBytes: declared,
        maxBytes: this.maxBytes,
      });
      return { status: "too_large", media: null };
    }

    try {
      const stream = this.implementation
        ? await this.implementation(message, socket)
        : await defaultDownload(message, socket);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > this.maxBytes) {
          try {
            stream.destroy?.();
          } catch {
            // Best effort. The cap already stopped local buffering.
          }
          this.log.warn("media download aborted: actual size exceeds limit", {
            maxBytes: this.maxBytes,
          });
          return { status: "too_large", media: null };
        }
        chunks.push(bytes);
      }

      const bytes = Buffer.concat(chunks, total);
      return {
        status: "ready",
        media: {
          bytes,
          mime: mediaMime(message),
          sizeBytes: bytes.length,
        },
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const expired = /410|expired|not.*found|no longer/i.test(messageText);
      this.log.warn("media download failed", {
        reason: expired ? "expired" : "download_failed",
      });
      return { status: expired ? "expired" : "failed", media: null };
    }
  }
}
