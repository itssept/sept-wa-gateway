/**
 * Adapter tests: the verified ask -> wait flow, analyzing re-poll, and
 * waiting_approval auto-decline. fetch is stubbed with scripted SSE responses.
 */

import { test, expect, afterEach } from "bun:test";
import { PromptQlAdapter } from "../src/promptql/promptqlAdapter.ts";
import { testConfig } from "./helpers.ts";

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
