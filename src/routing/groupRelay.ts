import type { InboundMessage } from "../whatsapp/socket.ts";
import type { Shopper } from "../domain/types.ts";

/** Change this helper if SEPT chooses masked or pseudonymous sender labels. */
export function senderLabel(
  msg: InboundMessage,
  shopper?: Pick<Shopper, "name">,
): string {
  // A LID is opaque, never manufacture an E.164 number from it.
  const identity = msg.senderPhoneE164 ?? `WhatsApp ${msg.senderJid}`;
  const name = shopper?.name.replace(/[\r\n[\]]/g, " ").trim();
  return name ? `${name}, ${identity}` : identity;
}

export function groupQuery(msg: InboundMessage, label: string): string {
  const text = msg.text.replace(/@\d+/g, "").trim();
  const marker = msg.msgType !== "text" ? `[WhatsApp ${msg.msgType}]` : "";
  return `[${label}] ${[marker, text].filter(Boolean).join(" ") || "[mention]"}`;
}

export const GROUP_INSTRUCTION =
  "This message came from a WhatsApp group; [sender] prefixes identify group members; reply only to the tagger of this message, and your reply will be sent to the group.";