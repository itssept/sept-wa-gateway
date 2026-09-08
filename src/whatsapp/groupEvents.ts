/** Validated Baileys identity, mention and membership boundaries. */
import { z } from "zod";
import { normalizeMessageContent, proto, type WAMessage } from "baileys";

const Jid = z.string().regex(/^[^@\s]+@[^@\s]+$/);
const OwnUser = z.object({ id: Jid, lid: Jid.optional() });
const Participant = z.object({
  id: Jid,
  lid: Jid.optional(),
  phoneNumber: Jid.optional(),
});
const GroupId = z.string().regex(/^[^@\s]+@g\.us$/);
const ParticipantUpdate = z.object({
  id: GroupId,
  // Some runtime stub events omit author even though the declaration requires it.
  author: Jid.nullish(),
  participants: z.array(Participant),
  action: z.enum(["add", "remove", "promote", "demote", "modify"]),
});
const GroupUpserts = z.array(z.object({
  id: GroupId,
  participants: z.array(Participant),
}));
const MentionContext = z.object({ mentionedJid: z.array(Jid).nullish() });

/** Keep the domain: a PN and LID with equal digits are not the same identity. */
function bareJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "");
}

export function ownJids(user: unknown): Set<string> {
  const parsed = OwnUser.safeParse(user);
  if (!parsed.success) return new Set();
  return new Set([parsed.data.id, parsed.data.lid]
    .filter((jid): jid is string => Boolean(jid)).map(bareJid));
}

export function mentionsSelf(message: WAMessage, user: unknown): boolean {
  if (message.key.fromMe) return false;
  const own = ownJids(user);
  const content = normalizeMessageContent(message.message);
  if (!content) return false;
  // Inspect only the current content, never quotedMessage's contextInfo.
  return Object.values(content).some((value) => {
    if (!value || typeof value !== "object" || !("contextInfo" in value)) return false;
    const parsed = MentionContext.safeParse(value.contextInfo);
    return parsed.success && Boolean(
      parsed.data.mentionedJid?.some((jid) => own.has(bareJid(jid))),
    );
  });
}

export interface SelfMembershipEvent {
  connectionId: string;
  groupJid: string;
}

export function selfParticipantUpdate(
  payload: unknown,
  user: unknown,
): { groupJid: string; action: "add" | "remove" } | null {
  const update = ParticipantUpdate.parse(payload);
  if (update.action !== "add" && update.action !== "remove") return null;
  const own = ownJids(user);
  if (!update.participants.some((p) => [p.id, p.lid, p.phoneNumber]
    .some((jid) => jid && own.has(bareJid(jid))))) return null;
  return { groupJid: update.id, action: update.action };
}

export function selfGroupUpserts(payload: unknown, user: unknown): string[] {
  const groups = GroupUpserts.parse(payload);
  const own = ownJids(user);
  return groups.filter((group) => group.participants.some((p) =>
    [p.id, p.lid, p.phoneNumber].some((jid) => jid && own.has(bareJid(jid))),
  )).map((group) => group.id);
}

// Baileys 7.0.0-rc14: Types/Events.d.ts. isLatest means the first sync,
// not the last chunk. There is no "joined group" flag on this payload.
const HistoryBatch = z.object({
  chats: z.array(z.object({ id: Jid }).passthrough()),
  contacts: z.array(z.object({ id: Jid }).passthrough()),
  messages: z.array(z.unknown()),
  isLatest: z.boolean().optional(),
  progress: z.number().min(0).max(100).nullish(),
  syncType: z.nativeEnum(proto.HistorySync.HistorySyncType).nullish(),
  chunkOrder: z.number().int().nonnegative().nullish(),
  peerDataRequestSessionId: z.string().nullish(),
});
const HistoryTimestamp = z.union([
  z.number().int().nonnegative().safe(),
  z.object({ low: z.number().int(), high: z.number().int(), unsigned: z.boolean() }),
]);
const HistoryContentNode = z.object({
  text: z.string().nullish(),
  caption: z.string().nullish(),
  mimetype: z.string().nullish(),
  fileLength: z.union([HistoryTimestamp, z.string().regex(/^\d+$/)]).nullish(),
  url: z.string().nullish(),
  directPath: z.string().nullish(),
  mediaKey: z.instanceof(Uint8Array).nullish(),
  contextInfo: z.object({ mentionedJid: z.array(Jid).nullish() }).passthrough().nullish(),
}).passthrough();
const HistoryContent: z.ZodType<unknown> = z.lazy(() => z.object({
  conversation: z.string().nullish(),
  extendedTextMessage: HistoryContentNode.nullish(),
  imageMessage: HistoryContentNode.nullish(),
  videoMessage: HistoryContentNode.nullish(),
  audioMessage: HistoryContentNode.nullish(),
  documentMessage: HistoryContentNode.nullish(),
  stickerMessage: HistoryContentNode.nullish(),
  ephemeralMessage: z.object({ message: HistoryContent.nullish() }).passthrough().nullish(),
  viewOnceMessage: z.object({ message: HistoryContent.nullish() }).passthrough().nullish(),
  viewOnceMessageV2: z.object({ message: HistoryContent.nullish() }).passthrough().nullish(),
  viewOnceMessageV2Extension: z.object({ message: HistoryContent.nullish() }).passthrough().nullish(),
  documentWithCaptionMessage: z.object({ message: HistoryContent.nullish() }).passthrough().nullish(),
}).passthrough());
const HistoryEnvelope = z.object({
  key: z.object({
    remoteJid: GroupId,
    id: z.string().min(1),
    participant: Jid.nullish(),
    participantAlt: Jid.nullish(),
    remoteJidAlt: Jid.nullish(),
    fromMe: z.boolean().nullish(),
  }).passthrough(),
  messageTimestamp: HistoryTimestamp,
  message: HistoryContent.nullish(),
  pushName: z.string().nullish(),
}).passthrough();

export function parseHistoryBatch(payload: unknown): z.infer<typeof HistoryBatch> {
  return HistoryBatch.parse(payload);
}

/** Validate consumed fields without stripping media keys, extensions or Longs. */
export function parseHistoryMessage(value: unknown): WAMessage | null {
  try {
    HistoryEnvelope.parse(value);
    const message = value as WAMessage;
    const seconds = Number(message.messageTimestamp);
    if (!Number.isSafeInteger(seconds * 1000) || seconds < 0) return null;
    return message;
  } catch {
    return null;
  }
}
