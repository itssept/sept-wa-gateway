/**
 * Adapter tests: the verified ask -> wait flow, analyzing re-poll, and
 * waiting_approval auto-decline. fetch is stubbed with scripted SSE responses.
 */

import { test, expect, afterEach } from "bun:test";
import { PromptQlAdapter, AskSubmissionError, promptQlFileFromMedia } from "../src/promptql/promptqlAdapter.ts";
import { testConfig } from "./helpers.ts";
import { TransientMediaDownloader } from "../src/whatsapp/media.ts";
import { createLogger } from "../src/logger.ts";
import type { WAMessage } from "baileys";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseOf(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** Route scripted responses by the JSON-RPC method / tool name in the request. */
function scriptByTool(handlers: {
  initialize?: unknown;
  toolResults: Array<{ result: unknown }>;
}): { toolCalls: Array<{ name: string; args: any }> } {
  const toolCalls: Array<{ name: string; args: any }> = [];
  let toolIdx = 0;
  globalThis.fetch = (async (_input: any, init: any) => {
    const body = JSON.parse(init.body);
    const headers = new Headers({ "content-type": "text/event-stream" });
    if (body.method === "initialize") {
      return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: {} }), { headers });
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    if (body.method === "tools/call") {
      toolCalls.push({ name: body.params.name, args: body.params.arguments });
      const next = handlers.toolResults[toolIdx++];
      return new Response(
        sseOf({ jsonrpc: "2.0", id: body.id, result: next?.result ?? {} }),
        { headers },
      );
    }
    return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result: {} }), { headers });
  }) as typeof fetch;
  return { toolCalls };
}

const cfg = testConfig();
const deps = { config: cfg, getToken: () => "tok" };

test("ask returns thread_id + thread_event_id and passes room on new thread", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [
      { result: { structuredContent: { thread_id: "t1", thread_event_id: "e1" } } },
    ],
  });
  const a = new PromptQlAdapter(deps);
  const files = [
    {
      file_name: "whatsapp-image-message-1.jpg",
      mime_type: "image/jpeg",
      content_base64: "aW1hZ2U=",
    },
  ];
  const res = await a.ask("shopper-1", {
    query: "hi",
    threadId: null,
    roomName: "sept-x",
    files,
  });
  expect(res).toEqual({ threadId: "t1", threadEventId: "e1" });
  expect(toolCalls[0].name).toBe("ask_promptql");
  expect(toolCalls[0].args.room_name).toBe("sept-x");
  expect(toolCalls[0].args.files).toEqual(files);
  expect(toolCalls[0].args.thread_id).toBeUndefined();
});

test("ask rejects an invalid outbound file payload before transmission", async () => {
  const { toolCalls } = scriptByTool({ toolResults: [] });
  const a = new PromptQlAdapter(deps);
  await expect(
    a.ask("shopper-1", {
      query: "hi",
      files: [
        {
          file_name: "",
          mime_type: "image/jpeg",
          content_base64: "not base64!",
        },
      ],
    }),
  ).rejects.toThrow();
  expect(toolCalls).toHaveLength(0);
});

test("ask continues an existing thread (passes thread_id, no room)", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { thread_id: "t1", thread_event_id: "e2" } } }],
  });
  const a = new PromptQlAdapter(deps);
  await a.ask("shopper-1", { query: "again", threadId: "t1", roomName: null });
  expect(toolCalls[0].args.thread_id).toBe("t1");
  expect(toolCalls[0].args.room_name).toBeUndefined();
});

test("waitForResponse re-polls on analyzing then returns completed message", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [
      { result: { structuredContent: { status: "analyzing", message: "..." } } },
      { result: { structuredContent: { status: "completed", message: "final answer" } } },
    ],
  });
  const a = new PromptQlAdapter(deps);
  const res = await a.waitForResponse(
    "shopper-1",
    { threadId: "t1", threadEventId: "e1" },
    Date.now() + 5_000,
  );
  expect(res).toEqual({ status: "completed", message: "final answer" });
  expect(toolCalls.every((c) => c.name === "get_latest_promptql_thread_response")).toBe(true);
  expect(toolCalls.length).toBe(2);
});

test("waiting_approval auto-declines and returns a console-approval notice", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [
      {
        result: {
          structuredContent: {
            status: "waiting_approval",
            message: "needs approval",
            approvals: [{ approval_id: "ap-1" }],
          },
        },
      },
      { result: { structuredContent: { status: "declined" } } }, // respond_to_promptql_approval
    ],
  });
  const a = new PromptQlAdapter(deps);
  const res = await a.waitForResponse(
    "shopper-1",
    { threadId: "t1", threadEventId: "e1" },
    Date.now() + 5_000,
  );
  expect(res.status).toBe("declined_approval");
  // Second tool call must be the decline.
  expect(toolCalls[1].name).toBe("respond_to_promptql_approval");
  expect(toolCalls[1].args).toEqual({ approval_id: "ap-1", decision: "decline" });
});

test("ask shapes group response control, instruction and configured project name", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { thread_id: "bot" } } }],
  });
  const config = testConfig();
  config.mcp.projectName = "sept";
  const a = new PromptQlAdapter({ config, getToken: () => "tok" });
  await a.ask("shopper-1", {
    query: "[Alice] hello",
    agentResponse: "force_respond",
    systemInstruction: "Reply to the tagger.",
  });
  expect(toolCalls[0]!.args).toEqual({
    query: "[Alice] hello", agent_response: "force_respond",
    system_instruction: "Reply to the tagger.", project_name: "sept",
  });
});

test("force_skip makes only the ask call; optional project name is omitted", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { thread_id: "bot" } } }],
  });
  const a = new PromptQlAdapter(deps);
  await a.ask("shopper-1", { query: "[Bob] context", threadId: "bot", agentResponse: "force_skip" });
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]!.args).toEqual({
    query: "[Bob] context", thread_id: "bot", agent_response: "force_skip",
  });
});

test("new MCP fields and returned bot handle are validated", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { thread_id: 123 } } }],
  });
  const a = new PromptQlAdapter(deps);
  await expect(a.ask("s", { query: "hello", agentResponse: "bad" as never })).rejects.toThrow();
  await expect(a.ask("s", { query: "hello", projectName: "" })).rejects.toThrow();
  expect(toolCalls).toHaveLength(0);
  await expect(a.ask("s", { query: "hello" })).rejects.toThrow("invalid bot handle");
});


test.each([null, "existing-bot"])("force_skip carries downloaded media on bot %s without polling", async (threadId) => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: {
      status: "success", thread_id: threadId ?? "new-bot", thread_event_id: "event",
    } } }],
  });
  const a = new PromptQlAdapter(deps);
  const bytes = Buffer.from([0, 1, 254, 255]);
  const file = promptQlFileFromMedia({
    bytes, sizeBytes: bytes.length, mime: "application/pdf", fileName: "invoice_0912.pdf",
  }, "fallback.pdf");
  await a.ask("client-sa", {
    query: "[Client] Priya Sharma\n(document: invoice_0912.pdf)",
    threadId, roomName: threadId ? null : "sept-common",
    agentResponse: "force_skip", files: [file],
  });
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]!.name).toBe("ask_promptql");
  expect(toolCalls[0]!.args).toEqual({
    query: "[Client] Priya Sharma\n(document: invoice_0912.pdf)",
    ...(threadId ? { thread_id: threadId } : { room_name: "sept-common" }),
    agent_response: "force_skip",
    files: [{ file_name: "invoice_0912.pdf", mime_type: "application/pdf", content_base64: "AAH+/w==" }],
  });
});

test("downloaded media uses fallback metadata and preserves binary bytes", () => {
  expect(promptQlFileFromMedia({
    bytes: Buffer.from("abc"), sizeBytes: 3, mime: undefined,
  }, "whatsapp-document-1")).toEqual({
    file_name: "whatsapp-document-1", mime_type: "application/octet-stream", content_base64: "YWJj",
  });
  expect(() => promptQlFileFromMedia({ bytes: "not bytes" } as never, "a")).toThrow();
});

test.each([
  { file_name: "../invoice.pdf" },
  { file_name: "invoice\n.pdf" },
  { mime_type: "not-a-mime" },
  { mime_type: "image/jpeg\r\nx-header: value" },
  { content_base64: "abc" },
  { content_base64: "YWJj=AAA" },
])("invalid attachment metadata never crosses the adapter boundary: %j", async (override) => {
  const { toolCalls } = scriptByTool({ toolResults: [] });
  const a = new PromptQlAdapter(deps);
  await expect(a.ask("client", {
    query: "hello", agentResponse: "force_skip",
    files: [{ file_name: "file.pdf", mime_type: "application/pdf", content_base64: "YWJj", ...override }],
  })).rejects.toThrow();
  expect(toolCalls).toHaveLength(0);
});

test("upload failure preserves the bot handle, does not poll/retry or expose server details", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: {
      status: "upload_failed", thread_id: "created-bot",
      error_message: "private filename and token",
    } } }],
  });
  const a = new PromptQlAdapter(deps);
  let error: unknown;
  try {
    await a.ask("client", {
      query: "[Client]\n(image)", agentResponse: "force_skip",
      files: [{ file_name: "image.jpg", mime_type: "image/jpeg", content_base64: "YWJj" }],
    });
  } catch (err) { error = err; }
  expect(error).toBeInstanceOf(AskSubmissionError);
  const failure = error as AskSubmissionError;
  expect(failure.status).toBe("upload_failed");
  expect(failure.ask).toEqual({ threadId: "created-bot", threadEventId: null });
  expect(failure.message).not.toContain("private");
  expect(toolCalls).toHaveLength(1);
});


test.each([
  ["imageMessage", "image/jpeg", "image.jpg"],
  ["videoMessage", "video/mp4", "video.mp4"],
  ["documentMessage", "application/pdf", "document.pdf"],
  ["audioMessage", "audio/ogg; codecs=opus", "voice.ogg"],
  ["stickerMessage", "image/webp", "sticker.webp"],
])("downloaded %s reaches a relay-only MCP post", async (field, mime, fallbackName) => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { status: "success", thread_id: "bot" } } }],
  });
  const downloader = new TransientMediaDownloader(
    1024, createLogger({ level: "error", sink: () => undefined }),
    async () => (async function* () { yield Buffer.from([0, 255, 10]); })(),
  );
  const result = await downloader.download({
    key: { id: "message", remoteJid: "group@g.us" },
    message: { [field]: { mimetype: mime, fileLength: 3, ptt: true } },
  } as WAMessage, {} as never);
  expect(result.status).toBe("ready");
  const a = new PromptQlAdapter(deps);
  await a.ask("client", {
    query: "[Client]\ncaption", agentResponse: "force_skip",
    files: [promptQlFileFromMedia(result.media!, fallbackName)],
  });
  expect(toolCalls).toHaveLength(1);
  const file = toolCalls[0]!.args.files[0];
  expect(file.file_name).toBe(fallbackName);
  expect(file.mime_type).toBe(mime);
  expect(Buffer.from(file.content_base64, "base64")).toEqual(Buffer.from([0, 255, 10]));
});

test("expired media can still be relayed as envelope text without a file", async () => {
  const { toolCalls } = scriptByTool({
    toolResults: [{ result: { structuredContent: { thread_id: "bot" } } }],
  });
  const a = new PromptQlAdapter(deps);
  await a.ask("client", {
    query: "[Client]\n(image)", agentResponse: "force_skip", files: [],
  });
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]!.args.files).toBeUndefined();
  expect(toolCalls[0]!.args.query).toBe("[Client]\n(image)");
});

test("shopper, PA, second shopper and Client use isolated sessions; invalidation never crosses roles", async () => {
  const calls: Array<{ method: string; auth: string | null }> = [];
  const tokens = new Map([["s:shopper", "shop-token"], ["s:pa", "pa-token"], ["b:shopper", "bob-token"]]);
  let clientToken: string | null = "client-token";
  globalThis.fetch = (async (_input: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, auth: new Headers(init.headers).get("Authorization") });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    const result = body.method === "tools/call"
      ? { structuredContent: { thread_id: "bot", thread_event_id: "event" } } : {};
    return new Response(sseOf({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const a = new PromptQlAdapter({
    config: cfg, getToken: (id, role) => tokens.get(`${id}:${role}`) ?? null, getClientToken: () => clientToken,
  });
  const shopper = { shopperId: "s", role: "shopper" } as const;
  const pa = { shopperId: "s", role: "pa" } as const;
  const client = { role: "client" } as const;
  for (const identity of [shopper, pa, "b", client, shopper, pa, client]) await a.ask(identity, { query: "x" });
  expect(calls.filter((c) => c.method === "initialize").map((c) => c.auth)).toEqual([
    "pat shop-token", "pat pa-token", "pat bob-token", "pat client-token",
  ]);
  tokens.set("s:pa", "new-pa"); a.invalidate(pa);
  await a.ask(pa, { query: "x" }); await a.ask(shopper, { query: "x" });
  expect(calls.filter((c) => c.method === "initialize").at(-1)!.auth).toBe("pat new-pa");
  tokens.delete("s:pa"); a.invalidate(pa);
  const before = calls.length;
  await expect(a.ask(pa, { query: "x" })).rejects.toThrow("no active MCP credential");
  expect(calls).toHaveLength(before);
  clientToken = "new-client"; a.invalidate(client);
  await a.ask(client, { query: "x" });
  expect(calls.filter((c) => c.method === "initialize").at(-1)!.auth).toBe("pat new-client");
  clientToken = null;
  await expect(a.ask(client, { query: "x" })).rejects.toThrow("no active MCP credential");
  await a.ask(shopper, { query: "x" });
  expect(calls.at(-1)!.auth).toBe("pat shop-token");
});
