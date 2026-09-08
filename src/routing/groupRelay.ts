import type { InboundMessage } from "../whatsapp/socket.ts";
import { formatClientEnvelope, type ClientEnvelopeInput } from "../promptql/clientEnvelope.ts";

/** One media label for live messages and replay, even if the download expired. */
export function mediaLabel(msg: InboundMessage): ClientEnvelopeInput["media"] {
  const kind = msg.msgType === "audio" && msg.ptt ? "voice note"
    : msg.msgType === "contact" ? "contact card" : msg.msgType;
  if (!["image", "video", "document", "sticker", "audio", "voice note", "contact card", "location"].includes(kind)) return null;
  return { kind: kind as NonNullable<ClientEnvelopeInput["media"]>["kind"], fileName: msg.fileName };
}

export function clientQuery(msg: InboundMessage): string {
  return formatClientEnvelope({
    displayName: msg.pushName,
    phoneE164: msg.senderPhoneE164,
    lid: msg.senderJid.endsWith("@lid") ? msg.senderJid : null,
    text: msg.text,
    media: mediaLabel(msg),
  });
}

export function paPrompt(shopperName: string): string {
  return `Please respond to the client message above on behalf of ${shopperName}.`;
}
