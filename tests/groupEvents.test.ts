import { expect, test } from "bun:test";
import type { WAMessage } from "baileys";
import { mentionsSelf, ownJids, selfParticipantUpdate, selfGroupUpserts } from "../src/whatsapp/groupEvents.ts";

const user = { id: "14155550000:7@s.whatsapp.net", lid: "999123:2@lid" };
const group = "120363123@g.us";
function message(mentionedJid: unknown, fromMe = false): WAMessage {
  return {
    key: { fromMe },
    message: { extendedTextMessage: { text: "hello", contextInfo: { mentionedJid } } },
  } as WAMessage;
}

test("PN and LID mentions match own identities, including device suffixes", () => {
  expect(ownJids(user)).toEqual(new Set(["14155550000@s.whatsapp.net", "999123@lid"]));
  expect(mentionsSelf(message(["14155550000@s.whatsapp.net"]), user)).toBe(true);
  expect(mentionsSelf(message(["999123@lid"]), user)).toBe(true);
  expect(mentionsSelf(message(["999123:8@lid"]), user)).toBe(true);
  expect(mentionsSelf(message(["999123@s.whatsapp.net"]), user)).toBe(false);
  expect(mentionsSelf(message(["14155559999@s.whatsapp.net"]), user)).toBe(false);
});

test("own messages never trigger and absent or malformed mentions fail closed", () => {
  expect(mentionsSelf(message(["999123@lid"], true), user)).toBe(false);
  for (const mentions of [null, undefined, "999123@lid", [7], ["not a jid"]]) {
    expect(mentionsSelf(message(mentions), user)).toBe(false);
  }
  expect(mentionsSelf(message(["999123@lid"]), undefined)).toBe(false);
});

test("wrapped media captions trigger, but quoted mentions do not", () => {
  const media = {
    key: { fromMe: false },
    message: { ephemeralMessage: { message: {
      imageMessage: { caption: "look", contextInfo: { mentionedJid: ["999123@lid"] } },
    } } },
  };
  expect(mentionsSelf(media, user)).toBe(true);
  const quote = {
    key: {},
    message: { extendedTextMessage: { text: "reply", contextInfo: {
      participant: "999123@lid",
      quotedMessage: { extendedTextMessage: { contextInfo: { mentionedJid: ["999123@lid"] } } },
    } } },
  };
  expect(mentionsSelf(quote, user)).toBe(false);
});

test("self remove and add match real Baileys participant objects on PN, LID and phoneNumber", () => {
  for (const participant of [
    { id: "14155550000@s.whatsapp.net" },
    { id: "999123@lid" },
    { id: "other@lid", phoneNumber: "14155550000@s.whatsapp.net" },
    { id: "other@s.whatsapp.net", lid: "999123@lid" },
  ]) {
    for (const action of ["add", "remove"] as const) {
      expect(selfParticipantUpdate({ id: group, participants: [participant], action }, user))
        .toEqual({ groupJid: group, action });
    }
  }
  expect(selfParticipantUpdate({
    id: group, participants: [{ id: "someone@lid" }], action: "remove",
  }, user)).toBeNull();
  expect(selfParticipantUpdate({
    id: group, participants: [{ id: "999123@lid" }], action: "promote",
  }, user)).toBeNull();
});

test("groups.upsert emits self-add only when the linked account is in participants", () => {
  expect(selfGroupUpserts([
    { id: group, participants: [{ id: "999123@lid" }] },
    { id: "other@g.us", participants: [{ id: "someone@lid" }] },
  ], user)).toEqual([group]);
});

test("membership boundary rejects the old string-array assumption and malformed payloads", () => {
  expect(() => selfParticipantUpdate({ id: group, action: "remove", participants: ["999123@lid"] }, user)).toThrow();
  expect(() => selfGroupUpserts([{ id: group, participants: null }], user)).toThrow();
});
test("inviter is retained with device suffix removed, never inferred from a LID", () => {
  expect(selfParticipantUpdate({
    id: group, action: "add", author: "inviter:4@lid", participants: [{ id: "999123@lid" }],
  }, user)).toEqual({ groupJid: group, action: "add", addedByJid: "inviter@lid" });
});
