/** Validated Baileys identity, mention and membership boundaries. */
import { z } from "zod";
import { normalizeMessageContent, type WAMessage } from "baileys";

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