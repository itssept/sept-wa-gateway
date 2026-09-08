import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AntiBanQueue, QueueFullError, type SendContext } from "../src/whatsapp/antiBan.ts";

afterEach(() => mock.restore());

function context(events: Array<string | number>, overrides: Partial<SendContext> = {}): SendContext {
  return {
    connectionId: "test-conn",
    chatJid: "123@g.us",
    textLength: 10,
    linkedAtMs: null,
    setComposing: async () => { events.push("composing"); },
    clearComposing: async () => { events.push("paused"); },
    ...overrides,
  };
}

// Record sleeps without real waits. Tests are serial and restore global spies.
function timers(events: Array<string | number>, random = 0.5) {
  spyOn(Math, "random").mockReturnValue(random);
  spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    events.push(ms);
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
}

for (const pacingProfile of [undefined, "default"] as const) {
  test(`${pacingProfile ?? "omitted"} profile keeps the existing typing sequence`, async () => {
    const events: Array<string | number> = [];
    timers(events);
    const queue = new AntiBanQueue({ sendRatePerSec: 100, warmupDays: 0 });
    await queue.enqueue(context(events, { pacingProfile }), async () => { events.push("send"); });
    expect(events).toEqual(["composing", 580, "send", "paused"]);
  });
}

for (const [random, pause] of [[0, 2_000], [0.5, 3_500], [0.999999, 5_000]] as const) {
  test(`PA pause samples ${pause}ms within default bounds`, async () => {
    const events: Array<string | number> = [];
    timers(events, random);
    const queue = new AntiBanQueue({ sendRatePerSec: 100, warmupDays: 0 });
    await queue.enqueue(context(events, { pacingProfile: "pa_reply" }), async () => { events.push("send"); });
    expect(events).toEqual([pause, "composing", Math.round(580 * (0.7 + random * 0.6)), "send", "paused"]);
  });
}

test("PA pause uses configured bounds without changing warm-up typing", async () => {
  const events: Array<string | number> = [];
  timers(events);
  const queue = new AntiBanQueue({
    sendRatePerSec: 100, warmupDays: 3,
    paReplyDelayMinMs: 100, paReplyDelayMaxMs: 900,
  });
  await queue.enqueue(context(events, { pacingProfile: "pa_reply", linkedAtMs: Date.now() }), async () => {
    events.push("send");
  });
  expect(events).toEqual([500, "composing", 1_450, "send", "paused"]);
});

test("PA pause holds the chat chain and backlog without blocking a different chat", async () => {
  const events: Array<string | number> = [];
  let releasePause!: () => void;
  let pauseStarted!: () => void;
  const started = new Promise<void>((resolve) => { pauseStarted = resolve; });
  timers(events);
  // Hold only the PA pause. Let the existing typing timers finish immediately.
  spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    if (ms === 3_500) {
      releasePause = callback;
      pauseStarted();
    } else {
      queueMicrotask(callback);
    }
    return 0;
  }) as unknown as typeof setTimeout);
  const queue = new AntiBanQueue({ sendRatePerSec: 100, warmupDays: 0, maxPendingPerConnection: 3 });
  const first = queue.enqueue(context(events, { pacingProfile: "pa_reply" }), async () => { events.push("first"); });
  const second = queue.enqueue(context(events), async () => { events.push("second"); });
  await started;
  // Neither composing nor sending can start in the paused chat.
  expect(events).toEqual([]);
  const other = queue.enqueue(context([], { chatJid: "other@g.us" }), async () => { events.push("other"); });
  await expect(queue.enqueue(context(events), async () => {})).rejects.toBeInstanceOf(QueueFullError);
  await other;
  expect(events).toEqual(["other"]);
  releasePause();
  await Promise.all([first, second]);
  expect(events).toEqual(["other", "composing", "first", "paused", "composing", "second", "paused"]);
});

test("a failed PA send clears presence and does not poison the next send", async () => {
  const events: Array<string | number> = [];
  timers(events);
  const queue = new AntiBanQueue({ sendRatePerSec: 100, warmupDays: 0 });
  const failed = queue.enqueue(context(events, { pacingProfile: "pa_reply" }), async () => {
    throw new Error("send failed");
  });
  const next = queue.enqueue(context(events), async () => { events.push("next"); });
  await expect(failed).rejects.toThrow("send failed");
  await next;
  expect(events).toEqual([3_500, "composing", 580, "paused", "composing", 580, "next", "paused"]);
});
