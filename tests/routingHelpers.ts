import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import type { InboundMessage, RoutingGroup } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
export const GROUP = "120363123@g.us";
export function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    connectionId: "test-conn", chatJid: GROUP,
    senderJid: "14155551111@s.whatsapp.net", senderPhoneE164: "+14155551111",
    messageId: crypto.randomUUID(), ts: Date.now(), text: "hello @14155550000",
    msgType: "text", mediaStatus: "none", media: null, isGroup: true,
    fromMe: false, mentionsSelf: false, ...overrides,
  };
}
export function setup(
  newBotId: () => string = () => "shared-bot",
  opts: { relayUnregisteredChats?: boolean } = {},
) {
  const app = makeTestApp();
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const a = ctx.shoppers.register("Alice", "+14155551111", "alice-room").shopper;
  const b = ctx.shoppers.register("Bob", "+14155552222", "bob-room").shopper;
  for (const s of [a, b]) {
    ctx.credentials.setActive(s.id, `shopper-${s.id}`);
    ctx.credentials.setActive(s.id, `pa-${s.id}`, { label: "pa" });
  }
  const calls: Array<{ identity: PostingIdentity; input: any }> = [];
  const dispatches: any[] = [];
  const reactions: Array<{ messageId: string; chatJid: string; emoji: string }> = [];
  let askHook: ((identity: PostingIdentity, input: any) => Promise<void>) | undefined;
  let group: RoutingGroup | null = {
    linkedMember: true,
    participants: [a, b].map((s) => ({ jid: s.phoneE164.slice(1) + "@s.whatsapp.net", phone_e164: s.phoneE164 })),
  };
  const adapter = { ask: async (identity: PostingIdentity, input: any) => {
    calls.push({ identity, input: structuredClone(input) });
    await askHook?.(identity, input);
    return { threadId: input.threadId ?? newBotId(), threadEventId: "event" };
  } };
  const router = new InboundRouter(
    ctx.resolver, adapter as never, ctx.workflows, ctx.chatBots, ctx.outboundLog,
    { dispatch: async (input: unknown) => { dispatches.push(input); } } as never,
    ctx.audit, ctx.log,
    { settings: ctx.gatewaySettings, messages: ctx.messages, getGroup: async () => group, prepareHistory: async () => null,
      reactToMessage: async (m, emoji) => { reactions.push({ messageId: m.messageId, chatJid: m.chatJid, emoji }); },
      relayUnregisteredChats: opts.relayUnregisteredChats ?? true },
  );
  return { ...app, a, b, calls, dispatches, reactions, router,
    setAskHook: (hook?: typeof askHook) => { askHook = hook; },
    setGroup: (next: RoutingGroup | null) => { group = next; } };
}
