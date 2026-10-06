import { expect, test, afterEach } from "bun:test";
import jpeg from "jpeg-js";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { AskSubmissionError, type PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";

const DM = "97336663062@s.whatsapp.net";

type App = ReturnType<typeof makeTestApp> & {
  calls: Array<{ identity: PostingIdentity; input: any }>;
  dispatches: unknown[];
  notices: string[];
  router: InboundRouter;
};

const apps: App[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

function setup(opts: {
  debounceMs: number;
  mediaBurstMs: number;
  failTimes?: number;
}): App {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const shopper = ctx.shoppers.register("Yara", "+97336663062", "operator-yara-aldhaen").shopper;
  ctx.credentials.setActive(shopper.id, `shopper-${shopper.id}`);

  let failsLeft = opts.failTimes ?? 0;
  const calls: App["calls"] = [];
  const dispatches: unknown[] = [];
  const notices: string[] = [];
  const router = new InboundRouter(
    ctx.resolver,
    {
      ask: async (identity: PostingIdentity, input: any) => {
        calls.push({ identity, input: structuredClone(input) });
        if ((input.files?.length ?? 0) > 0 && failsLeft > 0) {
          failsLeft -= 1;
          throw new AskSubmissionError("upload_failed", { threadId: "partial-bot", threadEventId: null }, "staging_error");
        }
        return { threadId: input.threadId ?? "album-bot", threadEventId: "album-evt" };
      },
    } as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    {
      dispatch: async (input: unknown) => { dispatches.push(input); },
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
      inboundDebounceMs: opts.debounceMs,
      mediaBurstMs: opts.mediaBurstMs,
      ephemeralMedia: { put: () => "should-not-be-used" } as never,
      publicBaseUrl: "http://gateway.test:8790",
    },
  );
  const res = { ...app, calls, dispatches, notices, router };
  apps.push(res);
  return res;
}

function photo(id: string, bytes: Buffer, text = ""): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: DM,
    senderJid: "97336663062@s.whatsapp.net",
    senderPhoneE164: "+97336663062",
    pushName: "Yara",
    messageId: id,
    ts: Date.now(),
    text,
    msgType: "image",
    mediaStatus: "ready",
    media: { bytes, mime: "image/jpeg", sizeBytes: bytes.length },
    isGroup: false,
    fromMe: false,
    mentionsSelf: false,
  };
}

function text(id: string, body: string): InboundMessage {
  return {
    ...photo(id, Buffer.alloc(0)),
    text: body,
    msgType: "text",
    mediaStatus: "none",
    media: null,
  };
}

function tinyJpeg(): Buffer {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 180; data[i + 1] = 30; data[i + 2] = 40; data[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width: 16, height: 16 }, 70).data);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a 34-photo album plus Please take orders is one ask with every image", async () => {
  const app = setup({ debounceMs: 20, mediaBurstMs: 120 });
  const bytes = tinyJpeg();
  const pending: Promise<void>[] = [];
  for (let i = 1; i <= 34; i++) {
    pending.push(app.router.handle(photo(`look-${i}`, bytes)));
    await sleep(30);
  }
  pending.push(app.router.handle(text("caption", "Please take orders")));
  await Promise.all(pending);

  expect(app.calls).toHaveLength(1);
  expect(app.dispatches).toHaveLength(1);
  expect(app.notices).toHaveLength(0);
  const ask = app.calls[0]!.input;
  expect(ask.agentResponse).toBe("force_respond");
  expect(ask.files).toHaveLength(34);
  expect(ask.query).toContain("Please take orders");
  expect(ask.query).not.toContain("upload_failed");
  expect(ask.query).not.toContain("ephemeral-media");
  expect(ask.query).not.toContain("SEPT was stopped");
  const first = Buffer.from(ask.files[0].content_base64, "base64");
  expect(first.subarray(0, 3).toString("hex")).toBe("ffd8ff");
});

test("upload_failed retries the same images as files and then one ask succeeds", async () => {
  const app = setup({ debounceMs: 15, mediaBurstMs: 80, failTimes: 1 });
  const bytes = tinyJpeg();
  const pending: Promise<void>[] = [];
  for (let i = 1; i <= 12; i++) {
    pending.push(app.router.handle(photo(`retry-${i}`, bytes, i === 12 ? "Please take orders" : "")));
    await sleep(25);
  }
  await Promise.all(pending);

  expect(app.calls.length).toBeGreaterThanOrEqual(2);
  expect(app.notices).toHaveLength(0);
  const succeeded = app.calls.filter((c) => (c.input.files?.length ?? 0) === 12);
  expect(succeeded.length).toBeGreaterThanOrEqual(1);
  const ask = succeeded.at(-1)!.input;
  expect(ask.agentResponse).toBe("force_respond");
  expect(ask.query).toContain("Please take orders");
  expect(app.calls.every((c) => !String(c.input.query).includes("media bridge"))).toBe(true);
  expect(app.calls.every((c) => !String(c.input.query).includes("upload_failed"))).toBe(true);
  expect(app.dispatches).toHaveLength(1);
  const raw = Buffer.from(ask.files[0].content_base64, "base64");
  expect(raw.subarray(0, 3).toString("hex")).toBe("ffd8ff");
});
