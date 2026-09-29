import { expect, test, afterEach } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { AskSubmissionError, type PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import { sanitizeOutboundText } from "../src/routing/sanitizer.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";

type App = ReturnType<typeof makeTestApp> & {
  calls: Array<{ identity: PostingIdentity; input: any }>;
  notices: Array<{ connectionId: string; chatJid: string; text: string }>;
  router: InboundRouter;
  a: any;
};

const apps: App[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

function setup(opts: {
  failTimes?: number;
  status?: "upload_failed" | "sent_message_failed";
  failWhen?: (input: { files?: unknown[] }) => boolean;
  debounceMs?: number;
} = {}): App {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Yara", "+97336663062", "operator-yara-aldhaen").shopper;
  ctx.credentials.setActive(a.id, `shopper-${a.id}`);

  let failsLeft = opts.failTimes ?? 1;
  const status = opts.status ?? "upload_failed";
  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  const notices: Array<{ connectionId: string; chatJid: string; text: string }> = [];

  const adapter = {
    ask: async (identity: PostingIdentity, input: any) => {
      calls.push({ identity, input: structuredClone(input) });
      const shouldFail = opts.failWhen ? opts.failWhen(input) : true;
      if (shouldFail && failsLeft > 0) {
        failsLeft -= 1;
        throw new AskSubmissionError(status, { threadId: "partial-bot", threadEventId: null });
      }
      return { threadId: "ok-bot", threadEventId: "evt-1" };
    },
  };

  const router = new InboundRouter(
    ctx.resolver,
    adapter as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    {
      dispatch: async () => undefined,
      dispatchDirectText: async () => undefined,
      notifyChat: async (input: { connectionId: string; chatJid: string; text: string }) => {
        notices.push(input);
      },
    } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      reactToMessage: async () => undefined,
      relayUnregisteredChats: true,
      inboundDebounceMs: opts.debounceMs ?? 0,
    },
  );

  const res = { ...app, a, calls, notices, router };
  apps.push(res);
  return res;
}

function imageMsg(id: string): InboundMessage {
  return {
    connectionId: "test-conn",
    chatJid: "97336663062@s.whatsapp.net",
    senderJid: "97336663062@s.whatsapp.net",
    senderPhoneE164: "+97336663062",
    pushName: "Yara",
    messageId: id,
    ts: Date.now(),
    text: "",
    msgType: "image",
    mediaStatus: "ready",
    media: { bytes: Buffer.from("fake-dior"), mime: "image/jpeg", sizeBytes: 9 },
    isGroup: false,
    fromMe: false,
    mentionsSelf: false,
  };
}

const DM = "97336663062@s.whatsapp.net";

test("upload_failed once then success: retries and does not notify", async () => {
  const app = setup({ failTimes: 1 });
  await app.router.handle(imageMsg("img-1"));
  expect(app.calls).toHaveLength(2);
  expect(app.calls[1]!.input.files).toHaveLength(1);
  expect(app.calls[1]!.input.threadId).toBe("partial-bot");
  expect(app.notices).toHaveLength(0);
  expect(app.ctx.chatBots.pendingPost("test-conn", DM)).toBeNull();
});

test("upload_failed twice: notifies operator to resend", async () => {
  const app = setup({ failTimes: 2 });
  await app.router.handle(imageMsg("img-2"));
  expect(app.calls).toHaveLength(2);
  expect(app.notices).toHaveLength(1);
  expect(app.notices[0].text).toContain("couldn't upload");
  expect(app.notices[0].text.toLowerCase()).toContain("resend");
  expect(app.ctx.chatBots.pendingPost("test-conn", DM)?.query).toBe("(image)");
});

test("sent_message_failed on media notifies once without a second upload", async () => {
  const app = setup({ failTimes: 5, status: "sent_message_failed" });
  await app.router.handle(imageMsg("img-3"));
  expect(app.calls).toHaveLength(1);
  expect(app.notices).toHaveLength(1);
  expect(app.notices[0].text.toLowerCase()).toContain("resend");
});

test("operator resend notices survive outbound sanitizer", () => {
  for (const notice of [
    "Got your photo, but I couldn't upload it just now. Please resend it once and I'll pick it up.",
    "I hit a snag sending that to my workspace. Please resend and I'll try again.",
  ]) {
    expect(sanitizeOutboundText(notice).trim()).toBe(notice);
  }
});

test("two photos that fail as one upload are each uploaded, with no resend notice", async () => {
  const app = setup({
    failTimes: 5,
    debounceMs: 40,
    failWhen: (input) => (input.files?.length ?? 0) > 1,
  });
  await Promise.all([
    app.router.handle(imageMsg("img-bag")),
    app.router.handle(imageMsg("img-invoice")),
  ]);
  expect(app.calls[0]!.input.files).toHaveLength(2);
  expect(app.calls.slice(1).map((c) => c.input.files.length)).toEqual([1, 1]);
  expect(app.calls[1]!.input.agentResponse).toBe("force_skip");
  expect(app.calls[1]!.input.query).toBe("(image)");
  expect(app.calls[1]!.input.threadId).toBe("partial-bot");
  expect(app.calls[2]!.input.agentResponse).toBe("force_respond");
  expect(app.calls[2]!.input.query).toBe("(image)\n(image)");
  expect(app.notices).toHaveLength(0);
  expect(app.ctx.chatBots.pendingPost("test-conn", DM)).toBeNull();
});

test("two large photos are not bundled into one ask", async () => {
  const app = setup({ failTimes: 0, debounceMs: 40 });
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  big[0] = 0xff;
  big[1] = 0xd8;
  big[2] = 0xff;
  const photo = (id: string): InboundMessage => ({
    ...imageMsg(id),
    media: { bytes: big, mime: "image/jpeg", sizeBytes: big.length },
  });
  await Promise.all([
    app.router.handle(photo("big-1")),
    app.router.handle(photo("big-2")),
  ]);
  expect(app.calls).toHaveLength(2);
  expect(app.calls.every((c) => c.input.files.length === 1)).toBe(true);
  expect(app.notices).toHaveLength(0);
});

test("text upload_failed does not retry or notify", async () => {
  const app = setup({ failTimes: 2 });
  await app.router.handle({
    ...imageMsg("img-4"),
    text: "hello",
    msgType: "text",
    mediaStatus: "none",
    media: null,
  });
  expect(app.calls).toHaveLength(1);
  expect(app.notices).toHaveLength(0);
});

test("upload_failed then ephemeral bridge ask (no files) succeeds", async () => {
  const { EphemeralMediaStore } = await import("../src/http/ephemeralMedia.ts");
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Yara", "+97336663062", "operator-yara-aldhaen").shopper;
  ctx.credentials.setActive(a.id, `shopper-${a.id}`);

  const store = new EphemeralMediaStore();
  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  let fileAttempts = 0;

  const adapter = {
    ask: async (identity: PostingIdentity, input: any) => {
      calls.push({ identity, input: structuredClone(input) });
      if (input.files?.length) {
        fileAttempts += 1;
        throw new AskSubmissionError("upload_failed", { threadId: "partial-bot", threadEventId: null }, "staging_error");
      }
      // Bridge ask: no files, query carries the URL.
      expect(String(input.query)).toContain("/api/v1/ephemeral-media/");
      expect(String(input.query)).toContain("Invoice for this");
      return { threadId: "bridge-bot", threadEventId: "evt-bridge" };
    },
  };

  const notices: Array<{ connectionId: string; chatJid: string; text: string }> = [];
  const router = new InboundRouter(
    ctx.resolver,
    adapter as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    {
      dispatch: async () => undefined,
      dispatchDirectText: async () => undefined,
      notifyChat: async (input: { connectionId: string; chatJid: string; text: string }) => {
        notices.push(input);
      },
    } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      reactToMessage: async () => undefined,
      relayUnregisteredChats: true,
      inboundDebounceMs: 0,
      ephemeralMedia: store,
      publicBaseUrl: "http://gateway.test:8790",
    },
  );

  const msg = imageMsg("img-bridge-1");
  (msg as any).text = "Invoice for this";
  await router.handle(msg);

  expect(fileAttempts).toBeGreaterThanOrEqual(2);
  expect(calls.some((c) => !c.input.files?.length)).toBe(true);
  expect(notices).toHaveLength(0);
  expect(ctx.chatBots.pendingPost("test-conn", "97336663062@s.whatsapp.net")).toBeNull();
  app.db.close();
});

test("failed ephemeral bridge does not store the bearer URL as pending text", async () => {
  const { EphemeralMediaStore } = await import("../src/http/ephemeralMedia.ts");
  const app = setup();
  const store = new EphemeralMediaStore();
  const router = new InboundRouter(
    app.ctx.resolver,
    {
      ask: async () => {
        throw new AskSubmissionError(
          "upload_failed",
          { threadId: "partial-bot", threadEventId: null },
          "staging_error",
        );
      },
    } as never,
    app.ctx.workflows,
    app.ctx.chatBots,
    app.ctx.outboundLog,
    {
      dispatch: async () => undefined,
      dispatchDirectText: async () => undefined,
      notifyChat: async (input: { connectionId: string; chatJid: string; text: string }) => {
        app.notices.push(input);
      },
    } as never,
    app.ctx.audit,
    app.ctx.log,
    {
      settings: app.ctx.gatewaySettings,
      messages: app.ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      reactToMessage: async () => undefined,
      relayUnregisteredChats: true,
      inboundDebounceMs: 0,
      ephemeralMedia: store,
      publicBaseUrl: "http://gateway.test:8790",
    },
  );
  const msg = imageMsg("img-bridge-fail");
  (msg as { text: string }).text = "Invoice for this";
  await router.handle(msg);
  const pending = app.ctx.chatBots.pendingPost("test-conn", DM);
  expect(pending?.query).toBe("Invoice for this");
  expect(pending?.query ?? "").not.toContain("ephemeral-media");
  expect(app.notices).toHaveLength(1);
});
