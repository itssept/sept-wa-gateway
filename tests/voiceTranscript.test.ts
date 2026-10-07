import { afterEach, expect, test } from "bun:test";
import { loadConfig, resetConfigForTests } from "../src/config.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { orderStoredPdfIdentifiers } from "../src/promptql/promptqlAdapter.ts";
import {
  VOICE_TURN_CONTRACT,
  VOICE_UNAVAILABLE_NOTICE,
  VOICE_UNAVAILABLE_QUERY,
  createVoiceTranscriber,
  groundVoiceTurn,
  mergeVoiceQuery,
} from "../src/routing/voiceTranscript.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import { makeTestApp } from "./helpers.ts";

afterEach(resetConfigForTests);

const ENV = {
  GATEWAY_ADMIN_TOKEN: "test-admin-token-0123456789",
  DATA_ENCRYPTION_KEY: "00".repeat(32),
};

test("voice STT config defaults to off and accepts an endpoint", () => {
  resetConfigForTests();
  expect(loadConfig(ENV).voiceStt).toEqual({
    url: "",
    apiKey: undefined,
    model: "whisper-1",
    timeoutMs: 20_000,
  });
  resetConfigForTests();
  const configured = loadConfig({
    ...ENV,
    GATEWAY_VOICE_STT_URL: "https://stt.example.test/v1/audio/transcriptions",
    GATEWAY_VOICE_STT_API_KEY: "secret-key",
    GATEWAY_VOICE_STT_MODEL: "whisper-large",
    GATEWAY_VOICE_STT_TIMEOUT_MS: "5000",
  });
  expect(configured.voiceStt.url).toBe("https://stt.example.test/v1/audio/transcriptions");
  expect(configured.voiceStt.apiKey).toBe("secret-key");
  expect(configured.voiceStt.model).toBe("whisper-large");
  expect(configured.voiceStt.timeoutMs).toBe(5000);
});

test("an empty speech endpoint never calls the network", async () => {
  let called = false;
  const transcriber = createVoiceTranscriber({
    url: "",
    model: "whisper-1",
    timeoutMs: 1000,
    fetchImpl: async () => {
      called = true;
      return new Response("nope");
    },
  });
  expect(await transcriber.transcribe({
    bytes: Buffer.from("OggS"),
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
  })).toBeNull();
  expect(called).toBe(false);
});

test("speech endpoint posts multipart audio and returns text", async () => {
  const seen: { auth?: string; model?: string; fileName?: string; bytes?: string } = {};
  const transcriber = createVoiceTranscriber({
    url: "https://stt.example.test/v1/audio/transcriptions",
    apiKey: "secret-key",
    model: "whisper-1",
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.auth = headers.get("authorization") ?? undefined;
      const form = init?.body as FormData;
      seen.model = String(form.get("model"));
      const file = form.get("file") as File;
      seen.fileName = file.name;
      seen.bytes = Buffer.from(await file.arrayBuffer()).toString("utf8");
      return new Response(JSON.stringify({ text: "  the client wants the small gold Kelly  " }), { status: 200 });
    },
  });
  const text = await transcriber.transcribe({
    bytes: Buffer.from("OggS-voice"),
    mimeType: "audio/ogg; codecs=opus",
    fileName: "voice.ogg",
  });
  expect(text).toBe("the client wants the small gold Kelly");
  expect(seen.auth).toBe("Bearer secret-key");
  expect(seen.model).toBe("whisper-1");
  expect(seen.fileName).toBe("voice.ogg");
  expect(seen.bytes).toBe("OggS-voice");
});

test("speech endpoint failures become an empty transcript", async () => {
  const transcriber = createVoiceTranscriber({
    url: "https://stt.example.test/v1/audio/transcriptions",
    model: "whisper-1",
    timeoutMs: 1000,
    fetchImpl: async () => new Response("no", { status: 500 }),
  });
  expect(await transcriber.transcribe({
    bytes: Buffer.from("OggS"),
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
  })).toBeNull();
});

test("mergeVoiceQuery replaces the voice placeholder once", () => {
  expect(mergeVoiceQuery("(voice note)", "the small gold Kelly")).toBe("the small gold Kelly");
  expect(mergeVoiceQuery("[Client] Yara\n[Phone] +973\n[Message] (voice note)", "hello")).toBe(
    "[Client] Yara\n[Phone] +973\n[Message] hello",
  );
  expect(mergeVoiceQuery("Please check this bag", "the small gold Kelly")).toBe(
    "Please check this bag\n\nthe small gold Kelly",
  );
});

test("groundVoiceTurn drops audio bytes and keeps a photo", async () => {
  const audio = Buffer.from("OggS-voice").toString("base64");
  const image = Buffer.from("image-bytes").toString("base64");
  const grounded = await groundVoiceTurn({
    messages: [
      { msgType: "audio", mediaStatus: "ready", media: { mime: "audio/ogg" } },
      { msgType: "image", mediaStatus: "ready", media: { mime: "image/jpeg" } },
    ],
    files: [
      { file_name: "voice.ogg", mime_type: "audio/ogg", content_base64: audio },
      { file_name: "bag.jpg", mime_type: "image/jpeg", content_base64: image },
    ],
    query: "Please check this bag\n(voice note)",
    transcribe: async (request) => {
      expect(request.bytes.toString("utf8")).toBe("OggS-voice");
      return "the client wants the small gold Kelly";
    },
  });
  expect(grounded.voice).toBe(true);
  expect(grounded.transcriptReady).toBe(true);
  expect(grounded.voiceOnly).toBe(false);
  expect(grounded.files).toEqual([
    { file_name: "bag.jpg", mime_type: "image/jpeg", content_base64: image },
  ]);
  expect(grounded.query).toContain("Please check this bag");
  expect(grounded.query).toContain("the client wants the small gold Kelly");
  expect(grounded.query).not.toContain("OggS");
  expect(grounded.query).not.toContain(audio);
});

test("document recovery skips invoice-named files", () => {
  const listed = [
    {
      identifier: "sept_invoice_20332",
      title: "SEPT-INV-20332.pdf",
      artifact_type: "pdf",
      mime_type: "application/pdf",
      artifact_reference: { artifact_id: "inv", version: 0 },
    },
    {
      identifier: "fw26_lookbook",
      title: "FW26 Lookbook.pdf",
      artifact_type: "pdf",
      mime_type: "application/pdf",
      artifact_reference: { artifact_id: "book", version: 0 },
    },
  ];
  expect(orderStoredPdfIdentifiers(listed, "document")).toEqual(["fw26_lookbook"]);
  expect(orderStoredPdfIdentifiers(listed, "invoice")).toEqual(["sept_invoice_20332", "fw26_lookbook"]);
});

const apps: Array<{ db: { close(): void } }> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

function shopperRouter(
  transcribe: (bytes: Buffer) => Promise<string | null>,
) {
  const app = makeTestApp();
  apps.push(app);
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const shopper = ctx.shoppers.register("Yara", "+97336663062", "operator-yara").shopper;
  ctx.credentials.setActive(shopper.id, `shopper-${shopper.id}`);
  const calls: Array<{ identity: PostingIdentity; input: { query: string; files?: Array<{ mime_type: string; content_base64: string }>; systemInstruction?: string; agentResponse?: string } }> = [];
  const notices: string[] = [];
  const dispatches: unknown[] = [];
  const router = new InboundRouter(
    ctx.resolver,
    { ask: async (identity: PostingIdentity, input: { query: string; files?: Array<{ mime_type: string; content_base64: string }>; systemInstruction?: string; agentResponse?: string }) => {
      calls.push({ identity, input });
      return { threadId: "bot", threadEventId: "evt" };
    } } as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    {
      dispatch: async (input: unknown) => { dispatches.push(input); },
      dispatchDirectText: async () => undefined,
      notifyChat: async (input: { text: string }) => { notices.push(input.text); },
    } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      relayUnregisteredChats: true,
      inboundDebounceMs: 0,
      mediaBurstMs: 0,
      voiceTranscriber: {
        transcribe: async (request) => transcribe(request.bytes),
      },
    },
  );
  return { router, calls, notices, dispatches, shopper };
}

function voiceMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: "97336663062@s.whatsapp.net",
    senderJid: "97336663062@s.whatsapp.net",
    senderPhoneE164: "+97336663062",
    pushName: "Yara",
    messageId: "voice-1",
    ts: Date.now(),
    text: "",
    msgType: "audio",
    ptt: true,
    mediaStatus: "ready",
    media: {
      bytes: Buffer.from("OggS-voice-note"),
      mime: "audio/ogg; codecs=opus",
      sizeBytes: 16,
    },
    isGroup: false,
    fromMe: false,
    mentionsSelf: false,
    ...overrides,
  };
}

test("a transcribed voice note is text on the ask and the audio is not uploaded", async () => {
  const { router, calls, notices, dispatches } = shopperRouter(async () => "the client wants the small gold Kelly");
  await router.handle(voiceMessage());
  expect(notices).toEqual([]);
  expect(calls).toHaveLength(1);
  const ask = calls[0]!.input;
  expect(ask.agentResponse).toBe("force_respond");
  expect(ask.query).toBe("the client wants the small gold Kelly");
  expect(ask.query).not.toContain("OggS");
  expect(ask.files ?? []).toEqual([]);
  expect(ask.systemInstruction).toContain("THIS TURN INCLUDES A WHATSAPP VOICE NOTE");
  expect(ask.systemInstruction).toContain(VOICE_TURN_CONTRACT);
  expect(ask.systemInstruction).not.toContain("Kelly");
  expect(ask.systemInstruction?.toLowerCase()).not.toContain("generativelanguage");
  expect(dispatches).toHaveLength(1);
});

test("a voice note with no transcript does not start a responding run", async () => {
  const { router, calls, notices, dispatches } = shopperRouter(async () => null);
  await router.handle(voiceMessage({ messageId: "voice-none" }));
  expect(notices).toEqual([VOICE_UNAVAILABLE_NOTICE]);
  expect(dispatches).toEqual([]);
  expect(calls).toHaveLength(1);
  const ask = calls[0]!.input;
  expect(ask.agentResponse).toBe("force_skip");
  expect(ask.query).toBe(VOICE_UNAVAILABLE_QUERY);
  expect(ask.files ?? []).toEqual([]);
  expect(JSON.stringify(ask)).not.toContain("OggS");
  expect(ask.systemInstruction).toContain("audio was not uploaded");
});

test("a failed transcriber is the same as no transcript", async () => {
  const { router, calls, notices } = shopperRouter(async () => {
    throw new Error("stt down");
  });
  await router.handle(voiceMessage({ messageId: "voice-throw", media: {
    bytes: Buffer.from("OggS-fail"),
    mime: "audio/ogg",
    sizeBytes: 8,
  } }));
  expect(notices).toEqual([VOICE_UNAVAILABLE_NOTICE]);
  expect(calls[0]!.input.agentResponse).toBe("force_skip");
  expect(calls[0]!.input.files ?? []).toEqual([]);
});

test("an expired voice note is not sent to PromptQL as audio", async () => {
  const { router, calls, notices } = shopperRouter(async () => {
    throw new Error("should not be called");
  });
  await router.handle(voiceMessage({
    messageId: "voice-expired",
    mediaStatus: "expired",
    media: null,
  }));
  expect(notices).toEqual([VOICE_UNAVAILABLE_NOTICE]);
  expect(calls[0]!.input.files ?? []).toEqual([]);
  expect(calls[0]!.input.agentResponse).toBe("force_skip");
});

test("typed shopper text is unchanged and carries no voice contract", async () => {
  const { router, calls, notices } = shopperRouter(async () => "nope");
  await router.handle(voiceMessage({
    messageId: "text-1",
    text: "The Kelly is in gold",
    msgType: "text",
    ptt: false,
    mediaStatus: "none",
    media: null,
  }));
  expect(notices).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.query).toBe("The Kelly is in gold");
  expect(calls[0]!.input.systemInstruction).toBeUndefined();
  expect(calls[0]!.input.agentResponse).toBe("force_respond");
});
