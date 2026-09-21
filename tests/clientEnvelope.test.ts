import { expect, test } from "bun:test";
import {
  formatClientEnvelope,
  type ClientEnvelopeInput,
} from "../src/promptql/clientEnvelope.ts";

const client = { displayName: "Priya Sharma", phoneE164: "+447700900123" };
const header = "[Client] Priya Sharma\n[Phone] +447700900123";

test("plain text matches the plan exactly", () => {
  const text = "Can you find the Bottega Jodie in size medium, black?";
  expect(formatClientEnvelope({ ...client, text }))
    .toBe(`${header}\n[Message] ${text}`);
});

test("caption is the text, with no media marker or attachment claim", () => {
  expect(formatClientEnvelope({
    ...client,
    text: "This colour, do you have it in stock?",
    media: { kind: "image" },
  })).toBe(`${header}\n[Message] This colour, do you have it in stock?`);
});

test("document without caption uses its filename", () => {
  expect(formatClientEnvelope({
    ...client, text: "",
    media: { kind: "document", fileName: "invoice_0912.pdf" },
  })).toBe(`${header}\n[Message] (document: invoice_0912.pdf)`);
});

test.each([undefined, null, "", " \t "])("missing display name (%s) leaves the client line blank", (displayName) => {
  expect(formatClientEnvelope({ ...client, displayName, text: "Hi" }))
    .toBe("[Client] \n[Phone] +447700900123\n[Message] Hi");
});

test("a LID replaces a missing phone under its own [ID] label", () => {
  expect(formatClientEnvelope({
    displayName: "Priya Sharma", lid: "123456789@lid", text: "Hi",
  })).toBe("[Client] Priya Sharma\n[ID] 123456789@lid\n[Message] Hi");
  expect(formatClientEnvelope({ lid: "123456789@lid", text: "Hi" }))
    .toBe("[Client] \n[ID] 123456789@lid\n[Message] Hi");
});

test("phone takes precedence over LID; neither leaves a blank [Phone] line", () => {
  expect(formatClientEnvelope({ ...client, lid: "123456789@lid", text: "Hi" }))
    .toBe(`${header}\n[Message] Hi`);
  expect(formatClientEnvelope({ displayName: "Priya Sharma", text: "Hi" }))
    .toBe("[Client] Priya Sharma\n[Phone] \n[Message] Hi");
  expect(formatClientEnvelope({ text: "Hi" }))
    .toBe("[Client] \n[Phone] \n[Message] Hi");
});

const kinds: Array<NonNullable<ClientEnvelopeInput["media"]>["kind"]> = [
  "image", "video", "document", "sticker", "audio", "voice note", "contact card", "location",
];

test.each(kinds)("uncaptioned %s uses only the media kind", (kind) => {
  expect(formatClientEnvelope({ ...client, text: "", media: { kind } }))
    .toBe(`${header}\n[Message] (${kind})`);
});

test.each(kinds)("captioned %s preserves the caption verbatim", (kind) => {
  expect(formatClientEnvelope({ ...client, text: " first\nsecond ", media: { kind } }))
    .toBe(`${header}\n[Message]  first\nsecond `);
});

test("blank captions fall back to media kind", () => {
  expect(formatClientEnvelope({ ...client, text: " \n", media: { kind: "voice note" } }))
    .toBe(`${header}\n[Message] (voice note)`);
});

test("live and replayed posts add neither timestamps nor reply quotes", () => {
  const live = { ...client, text: "Hi", ts: 100, quotedText: "old message", replayed: false };
  const replayed = { ...live, ts: 200, replayed: true };
  expect(formatClientEnvelope(live)).toBe(`${header}\n[Message] Hi`);
  expect(formatClientEnvelope(replayed)).toBe(formatClientEnvelope(live));
});

test("untrusted metadata cannot split the header or media label across lines", () => {
  expect(formatClientEnvelope({
    displayName: "Priya\nSharma", lid: "123@lid\r\n",
    text: "", media: { kind: "document", fileName: "invoice one.pdf" },
  })).toBe("[Client] Priya Sharma\n[ID] 123@lid\n[Message] (document: invoice one.pdf)");
});

test("invalid metadata types and a non-E.164 phone fail validation", () => {
  expect(() => formatClientEnvelope({ text: "Hi", phoneE164: "123456789@lid" })).toThrow();
  expect(() => formatClientEnvelope({ text: 42 } as never)).toThrow();
  expect(() => formatClientEnvelope({ text: "", media: { kind: "bad" } } as never)).toThrow();
});
