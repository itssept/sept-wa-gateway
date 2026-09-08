import { expect, test } from "bun:test";
import {
  formatClientEnvelope,
  type ClientEnvelopeInput,
} from "../src/promptql/clientEnvelope.ts";

const client = { displayName: "Priya Sharma" };
const header = "[Client] Priya Sharma";

test("plain text matches the plan exactly", () => {
  const text = "Can you find the Bottega Jodie in size medium, black?";
  expect(formatClientEnvelope({ ...client, text })).toBe(`${header}\n${text}`);
});

test("caption is the text, with no media marker or attachment claim", () => {
  expect(formatClientEnvelope({
    ...client,
    text: "This colour, do you have it in stock?",
    media: { kind: "image" },
  })).toBe(`${header}\nThis colour, do you have it in stock?`);
});

test("document without caption uses its filename", () => {
  expect(formatClientEnvelope({
    ...client, text: "",
    media: { kind: "document", fileName: "invoice_0912.pdf" },
  })).toBe(`${header}\n(document: invoice_0912.pdf)`);
});

test.each([undefined, null, "", " \t "])("missing display name (%s) leaves the bare tag", (displayName) => {
  expect(formatClientEnvelope({ ...client, displayName, text: "Hi" }))
    .toBe("[Client]\nHi");
});

test("the client's phone/LID identity is never included", () => {
  // Identity fields are dropped from the schema; only [Client] + name remain.
  expect(formatClientEnvelope({ displayName: "Priya Sharma", text: "Hi" }))
    .toBe("[Client] Priya Sharma\nHi");
  expect(formatClientEnvelope({ text: "Hi" })).toBe("[Client]\nHi");
});

const kinds: Array<NonNullable<ClientEnvelopeInput["media"]>["kind"]> = [
  "image", "video", "document", "sticker", "audio", "voice note", "contact card", "location",
];

test.each(kinds)("uncaptioned %s uses only the media kind", (kind) => {
  expect(formatClientEnvelope({ ...client, text: "", media: { kind } }))
    .toBe(`${header}\n(${kind})`);
});

test.each(kinds)("captioned %s preserves the caption verbatim", (kind) => {
  expect(formatClientEnvelope({ ...client, text: " first\nsecond ", media: { kind } }))
    .toBe(`${header}\n first\nsecond `);
});

test("blank captions fall back to media kind", () => {
  expect(formatClientEnvelope({ ...client, text: " \n", media: { kind: "voice note" } }))
    .toBe(`${header}\n(voice note)`);
});

test("live and replayed posts add neither timestamps nor reply quotes", () => {
  const live = { ...client, text: "Hi", ts: 100, quotedText: "old message", replayed: false };
  const replayed = { ...live, ts: 200, replayed: true };
  expect(formatClientEnvelope(live)).toBe(`${header}\nHi`);
  expect(formatClientEnvelope(replayed)).toBe(formatClientEnvelope(live));
});

test("untrusted metadata cannot split the header or media label across lines", () => {
  expect(formatClientEnvelope({
    displayName: "Priya\nSharma",
    text: "", media: { kind: "document", fileName: "invoice one.pdf" },
  })).toBe("[Client] Priya Sharma\n(document: invoice one.pdf)");
});

test("invalid metadata types fail validation", () => {
  expect(() => formatClientEnvelope({ text: 42 } as never)).toThrow();
  expect(() => formatClientEnvelope({ text: "", media: { kind: "bad" } } as never)).toThrow();
});
