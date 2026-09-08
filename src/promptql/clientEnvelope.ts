import { z } from "zod";

const ClientEnvelopeSchema = z.object({
  displayName: z.string().nullish(),
  phoneE164: z.string().regex(/^\+[1-9]\d{5,14}$/).nullish(),
  /** Opaque WhatsApp identity. Never interpret LID digits as a phone number. */
  lid: z.string().nullish(),
  /** The message body, or the caption for media. */
  text: z.string(),
  media: z.object({
    kind: z.enum([
      "image", "video", "document", "sticker", "audio", "voice note",
      "contact card", "location",
    ]),
    fileName: z.string().nullish(),
  }).nullish(),
});

export type ClientEnvelopeInput = z.infer<typeof ClientEnvelopeSchema>;

/** Shared by live and replayed client posts. Routing adds no other envelope. */
export function formatClientEnvelope(input: ClientEnvelopeInput): string {
  const value = ClientEnvelopeSchema.parse(input);
  // Sender-supplied metadata must not create extra header/body lines.
  const singleLine = (text: string | null | undefined) =>
    text?.replace(/[\r\n\u2028\u2029]/g, " ").trim();
  const name = singleLine(value.displayName);
  const identity = value.phoneE164 ?? (singleLine(value.lid) || "no phone");
  const header = `[Client] ${name ? `${name}, ` : ""}${identity}`;
  let text = value.text;
  if (!text.trim() && value.media) {
    const fileName = singleLine(value.media.fileName);
    text = value.media.kind === "document" && fileName
      ? `(document: ${fileName})`
      : `(${value.media.kind})`;
  }
  return `${header}\n${text}`;
}