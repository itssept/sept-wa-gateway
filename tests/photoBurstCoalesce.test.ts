import { afterEach, expect, test } from "bun:test";
import type { WAMessage } from "baileys";
import { WhatsAppConnection } from "../src/whatsapp/socket.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import { makeTestApp, testConfig } from "./helpers.ts";

const DM = "14155551111@s.whatsapp.net";
const user = { id: "97300000000:7@s.whatsapp.net", lid: "999123@lid" };

type BurstApp = ReturnType<typeof makeTestApp> & {
  calls: Array<{ identity: PostingIdentity; input: { agentResponse: string; query: string; files?: Array<{ content_base64: string }> } }>;
  dispatches: unknown[];
  releaseAll: () => void;
  push: (message: WAMessage) => void;
  settled: () => Promise<void>;
  conn: WhatsAppConnection;
};

const apps: BurstApp[] = [];
const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) {
    for (const wait of (app.conn as any).joinWaits.values()) clearTimeout(wait.timer);
    app.releaseAll();
    app.db.close();
  }
});

function setup(opts: { debounceMs: number; mediaBurstMs?: number; downloadDelayMs?: number }): BurstApp {
  const app = makeTestApp(testConfig({
    inboundDebounceMs: opts.debounceMs,
    mediaBurstMs: opts.mediaBurstMs ?? 0,
  }));
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const shopper = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  ctx.credentials.setActive(shopper.id, `shopper-${shopper.id}`);

  const calls: BurstApp["calls"] = [];
  const dispatches: unknown[] = [];
  const held: Array<() => void> = [];
  let router!: InboundRouter;
  const conn = new WhatsAppConnection(app.db, ctx.config, {} as never, ctx.messages, {
    onInbound: (msg) => router.handle(msg),
    onBurstTick: (msg) => router.touchBurst(msg),
  }, ctx.log);
  const sock = { user, groupMetadata: async () => ({ id: "none", participants: [] }) };
  (conn as any).live.sock = sock;
  (conn as any).media.download = async (message: WAMessage) => {
    if (opts.downloadDelayMs) await new Promise((r) => setTimeout(r, opts.downloadDelayMs));
    const image = message.message && "imageMessage" in message.message ? message.message.imageMessage : null;
    if (!image) return { status: "none" as const, media: null };
    const bytes = Buffer.from(`jpeg-${message.key.id}`);
    return { status: "ready" as const, media: { bytes, mime: "image/jpeg", sizeBytes: bytes.length } };
  };
  router = new InboundRouter(
    ctx.resolver,
    { ask: async (identity: PostingIdentity, input: any) => {
      calls.push({ identity, input: structuredClone(input) });
      return { threadId: "bot-1", threadEventId: `ev-${calls.length}` };
    } } as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    { dispatch: () => new Promise<void>((resolve) => { held.push(resolve); dispatches.push({ at: dispatches.length }); }) } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      relayUnregisteredChats: true,
      inboundDebounceMs: opts.debounceMs,
      mediaBurstMs: opts.mediaBurstMs ?? 0,
    },
  );
  const push = (message: WAMessage) => {
    const epochs = new Map((conn as any).groupEpochs);
    (conn as any).enqueueInbound(
      () => (conn as any).onMessagesUpsert({ messages: [message], type: "notify" }, sock, epochs),
      "test inbound failed",
    );
  };
  const settled = () => (conn as any).inboundQueue as Promise<void>;
  const res: BurstApp = {
    ...app,
    calls,
    dispatches,
    conn,
    push,
    settled,
    releaseAll: () => { for (const release of held.splice(0)) release(); },
  };
  apps.push(res);
  return res;
}

function text(id: string, body: string): WAMessage {
  return {
    key: { id, remoteJid: DM, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Alice",
    message: { conversation: body },
  };
}

function image(id: string, caption = ""): WAMessage {
  return {
    key: { id, remoteJid: DM, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Alice",
    message: { imageMessage: { mimetype: "image/jpeg", ...(caption ? { caption } : {}) } },
  };
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("5 photos plus a trailing caption become one ask, and a bare re-tag does not cancel it", async () => {
  const debounceMs = 180;
  const app = setup({ debounceMs });
  const images = [1, 2, 3, 4, 5].map((n) => image(`img-${n}`));
  for (const msg of images) {
    app.push(msg);
    await app.settled();
    await new Promise((r) => setTimeout(r, 20));
  }
  app.push(text("caption", "Please take orders"));
  await app.settled();

  await waitFor(() => app.calls.length >= 1, "photo burst ask");
  // Quiet window after the last message. Further flushes would show up here
  // if each photo had been its own triggering ask.
  await new Promise((r) => setTimeout(r, debounceMs + 60));
  expect(app.calls).toHaveLength(1);
  expect(app.dispatches).toHaveLength(1);
  expect(app.calls[0]!.input.agentResponse).toBe("force_respond");
  expect(app.calls[0]!.input.files).toHaveLength(5);
  expect(new Set(app.calls[0]!.input.files!.map((f) => f.content_base64)).size).toBe(5);
  expect(app.calls[0]!.input.query).toContain("Please take orders");
  expect(app.calls[0]!.identity.role).toBe("shopper");

  app.push(text("retag", "@SEPT"));
  await app.settled();
  await waitFor(() => app.calls.length >= 2, "bare re-tag");
  await new Promise((r) => setTimeout(r, debounceMs + 40));
  expect(app.calls.map((c) => c.input.agentResponse)).toEqual(["force_respond", "force_skip"]);
  expect(app.dispatches).toHaveLength(1);

  app.push(text("follow", "Ship the navy coat to Dina"));
  await app.settled();
  await waitFor(() => app.calls.length >= 3, "distinct follow-up");
  expect(app.calls[2]!.input.agentResponse).toBe("force_respond");
  expect(app.calls[2]!.input.query).toBe("Ship the navy coat to Dina");
  expect(app.dispatches).toHaveLength(2);
});

test("5 images arriving while a run is in flight are one follow-up ask, not five cancels", async () => {
  const debounceMs = 120;
  const app = setup({ debounceMs });
  app.push(text("status", "What is the status of the order"));
  await app.settled();
  await waitFor(() => app.dispatches.length === 1, "in-flight run");
  expect(app.calls).toHaveLength(1);
  expect(app.calls[0]!.input.agentResponse).toBe("force_respond");

  for (const n of [1, 2, 3, 4, 5]) {
    app.push(image(`burst-${n}`));
    await app.settled();
    await new Promise((r) => setTimeout(r, 15));
  }
  await waitFor(() => app.calls.length >= 2, "image follow-up");
  await new Promise((r) => setTimeout(r, debounceMs + 50));
  expect(app.calls).toHaveLength(2);
  expect(app.dispatches).toHaveLength(2);
  expect(app.calls[1]!.input.agentResponse).toBe("force_respond");
  expect(app.calls[1]!.input.files).toHaveLength(5);
  expect(app.calls[1]!.input.query).toContain("(image)");
});

test("a download slower than the quiet window still keeps the whole photo burst together", async () => {
  const debounceMs = 50;
  const app = setup({ debounceMs, downloadDelayMs: 90 });
  for (const n of [1, 2, 3, 4, 5]) {
    app.push(image(`slow-${n}`, n === 5 ? "invoice this" : ""));
    await app.settled();
  }
  await waitFor(() => app.calls.length >= 1, "slow burst");
  await new Promise((r) => setTimeout(r, debounceMs + 40));
  expect(app.calls).toHaveLength(1);
  expect(app.dispatches).toHaveLength(1);
  expect(app.calls[0]!.input.files).toHaveLength(5);
  expect(app.calls[0]!.input.query).toContain("invoice this");
  expect(app.calls[0]!.input.agentResponse).toBe("force_respond");
});

test("photos that arrive after the text debounce, but inside the album window, are one ask", async () => {
  const app = setup({ debounceMs: 40, mediaBurstMs: 280 });
  for (let n = 1; n <= 12; n++) {
    app.push(image(`gap-${n}`, n === 12 ? "Please take orders" : ""));
    await new Promise((r) => setTimeout(r, 90));
  }
  await app.settled();
  await waitFor(() => app.calls.length >= 1, "gapped album");
  await new Promise((r) => setTimeout(r, 120));
  expect(app.calls).toHaveLength(1);
  expect(app.dispatches).toHaveLength(1);
  expect(app.calls[0]!.input.agentResponse).toBe("force_respond");
  expect(app.calls[0]!.input.files).toHaveLength(12);
  expect(app.calls[0]!.input.query).toContain("Please take orders");
  expect(app.calls[0]!.input.query).not.toContain("upload_failed");
  expect(app.calls[0]!.input.query).not.toContain("SEPT was stopped");
});
