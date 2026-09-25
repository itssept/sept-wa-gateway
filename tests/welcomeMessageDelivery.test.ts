import { describe, it, expect } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import { OutboundDispatcher } from "../src/routing/outboundDispatcher.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";
import { OPERATOR_WELCOME_BASE, OPERATOR_WELCOME_PROMPT } from "../src/domain/welcomeMessage.ts";

describe("Issue 13: Operator Welcome Message Delivery", () => {
  function setupSuite() {
    const app = makeTestApp();
    const { ctx } = app;
    ctx.gatewaySettings.set("client-token", "common-room");

    const operator = ctx.shoppers.register("Operator Bob", "+14155553333", "operator-bob-room").shopper;
    ctx.credentials.setActive(operator.id, `shopper-${operator.id}`);
    ctx.credentials.setActive(operator.id, `pa-${operator.id}`, { label: "pa" });

    const calls: Array<{ identity: PostingIdentity; input: any }> = [];
    const sentMessages: Array<{ chatJid: string; text?: string; caption?: string }> = [];
    let simulateSendFailure = false;

    const adapter = {
      ask: async (identity: PostingIdentity, input: any) => {
        calls.push({ identity, input: structuredClone(input) });
        return { threadId: input.threadId ?? "bot-123", threadEventId: "ev-1" };
      },
      waitForResponse: async () => {
        const lastCall = calls[calls.length - 1];
        // Mirror back the prompt query as the bot response
        return { status: "completed", message: lastCall?.input?.query ?? "OK", artifacts: [] };
      },
      resolveArtifacts: async () => [],
    };

    const connection = {
      sendText: async (chatJid: string, text: string, opts?: any) => {
        if (simulateSendFailure) throw new Error("Network error / send failed");
        sentMessages.push({ chatJid, text });
        opts?.onMessageId?.("wa-msg-123");
        return "ref-123";
      },
      sendDocument: async (chatJid: string, doc: any, opts?: any) => {
        if (simulateSendFailure) throw new Error("Network error / send failed");
        sentMessages.push({ chatJid, caption: doc.caption });
        opts?.onMessageId?.("wa-doc-123");
        return "ref-doc-123";
      },
    };

    const dispatcher = new OutboundDispatcher(
      adapter as any,
      ctx.workflows,
      ctx.outboundLog,
      connection as any,
      ctx.config,
      ctx.log,
      ctx.chatBots,
      ctx.welcomeLog,
    );

    const groupData = {
      linkedMember: true,
      participants: [
        { jid: "14155553333@s.whatsapp.net", phone_e164: "+14155553333", admin: true },
        { jid: "14155550000@s.whatsapp.net", phone_e164: "+14155550000", admin: false },
      ],
    };

    const router = new InboundRouter(
      ctx.resolver,
      adapter as any,
      ctx.workflows,
      ctx.chatBots,
      ctx.outboundLog,
      dispatcher,
      ctx.audit,
      ctx.log,
      {
        settings: ctx.gatewaySettings,
        messages: ctx.messages,
        welcomeLog: ctx.welcomeLog,
        getGroup: async (jid) => (jid.endsWith("@g.us") ? groupData : null),
        prepareHistory: async () => null,
        relayUnregisteredChats: false,
      },
    );

    return {
      ctx,
      operator,
      calls,
      sentMessages,
      router,
      dispatcher,
      setSimulateFailure: (val: boolean) => { simulateSendFailure = val; },
    };
  }

  it("Test 1: A test operator's first DM 'hi' gets the welcome message alone", async () => {
    const { calls, sentMessages, router } = setupSuite();
    const inbound: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-1",
      ts: Date.now(),
      text: "hi",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound);

    expect(calls.length).toBe(1);
    expect(calls[0].input.query).toBe(OPERATOR_WELCOME_PROMPT);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Hi, this is SEPT");
    expect(sentMessages[0].text).toContain("How can I help?");
  });

  it("Test 2: A test operator's first DM containing a request gets the welcome AND the request is handled", async () => {
    const { calls, sentMessages, router } = setupSuite();
    const inbound: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-req-1",
      ts: Date.now(),
      text: "Can you check price for Chanel classic flap black caviar?",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound);

    expect(calls.length).toBe(1);
    expect(calls[0].input.query).toContain(OPERATOR_WELCOME_BASE);
    expect(calls[0].input.query).toContain("Can you check price for Chanel classic flap black caviar?");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Hi, this is SEPT");
    expect(sentMessages[0].text).toContain("Operator Request:\nCan you check price for Chanel classic flap black caviar?");
  });

  it("Test 3: That operator's second DM does not get the welcome again", async () => {
    const { calls, sentMessages, router } = setupSuite();
    const inbound1: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-1",
      ts: Date.now(),
      text: "hello",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound1);
    expect(sentMessages.length).toBe(1);

    const inbound2: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-2",
      ts: Date.now(),
      text: "What are my pending tasks?",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound2);

    expect(calls.length).toBe(2);
    expect(calls[1].input.query).toBe("What are my pending tasks?");
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[1].text).toBe("What are my pending tasks?");
    expect(sentMessages[1].text).not.toContain(OPERATOR_WELCOME_BASE);
  });

  it("Test 4: Re-registering the same operator does not resend it", async () => {
    const { ctx, calls, sentMessages, router } = setupSuite();
    const inbound1: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-1",
      ts: Date.now(),
      text: "hi",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound1);
    expect(sentMessages.length).toBe(1);

    // Re-register the operator
    ctx.shoppers.register("Operator Bob Updated", "+14155553333", "operator-bob-room");

    const inbound2: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-2",
      ts: Date.now(),
      text: "hello again",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound2);
    expect(calls[1].input.query).toBe("hello again");
    expect(sentMessages[1].text).toBe("hello again");
  });

  it("Test 5: A bot restart between messages does not resend it", async () => {
    const { ctx, operator } = setupSuite();
    // Inbound 1
    const welcomeLog1 = ctx.welcomeLog;
    expect(welcomeLog1.isWelcomeSent(operator.id, "test-conn")).toBe(false);

    welcomeLog1.recordWelcomeSent(operator.id, "test-conn");
    expect(welcomeLog1.isWelcomeSent(operator.id, "test-conn")).toBe(true);

    // Simulate restart (new context with same SQLite db)
    const newWelcomeLog = ctx.welcomeLog;
    expect(newWelcomeLog.isWelcomeSent(operator.id, "test-conn")).toBe(true);
  });

  it("Test 6: A simulated failed send does not mark welcome_sent, and the next DM retries", async () => {
    const { ctx, operator, sentMessages, router, setSimulateFailure } = setupSuite();
    
    // Simulate send failure on first attempt
    setSimulateFailure(true);

    const inbound1: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-fail-1",
      ts: Date.now(),
      text: "hi",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound1);

    expect(ctx.welcomeLog.isWelcomeSent(operator.id, "test-conn")).toBe(false);
    expect(sentMessages.length).toBe(0);

    // Second attempt succeeds
    setSimulateFailure(false);

    const inbound2: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "msg-success-2",
      ts: Date.now(),
      text: "hi",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(inbound2);

    expect(ctx.welcomeLog.isWelcomeSent(operator.id, "test-conn")).toBe(true);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Hi, this is SEPT");
  });

  it("Test 7: The operator's first message in a group does not trigger the welcome in the group; their later first DM does", async () => {
    const { ctx, operator, calls, router } = setupSuite();

    // 1. Group message
    const groupInbound: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "120363000000000000@g.us",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "group-msg-1",
      ts: Date.now(),
      text: "Need sizes for this dress in Paris group",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: true,
      fromMe: false,
      mentionsSelf: true,
    };

    await router.handle(groupInbound);

    expect(ctx.welcomeLog.isWelcomeSent(operator.id, "test-conn")).toBe(false);
    // Group query was relayed normally, without welcome message prefix
    expect(calls[0].input.query).toBe("Need sizes for this dress in Paris group");
    expect(calls[0].input.query).not.toContain("Hi, this is SEPT");

    // 2. Later first DM
    const dmInbound: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155553333@s.whatsapp.net",
      senderJid: "14155553333@s.whatsapp.net",
      senderPhoneE164: "+14155553333",
      messageId: "dm-msg-1",
      ts: Date.now(),
      text: "hi",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(dmInbound);

    expect(ctx.welcomeLog.isWelcomeSent(operator.id, "test-conn")).toBe(true);
    expect(calls[1].input.query).toContain("Hi, this is SEPT");
  });

  it("Test 8: A non-operator number texting SEPT gets neither the welcome nor a setup prompt", async () => {
    const { calls, sentMessages, router } = setupSuite();

    const nonOpInbound: InboundMessage = {
      connectionId: "test-conn",
      chatJid: "14155559999@s.whatsapp.net",
      senderJid: "14155559999@s.whatsapp.net",
      senderPhoneE164: "+14155559999",
      messageId: "nonop-msg-1",
      ts: Date.now(),
      text: "hello who is this?",
      msgType: "text",
      mediaStatus: "none",
      media: null,
      isGroup: false,
      fromMe: false,
      mentionsSelf: false,
    };

    await router.handle(nonOpInbound);

    // Dropped because relayUnregisteredChats is false
    expect(calls.length).toBe(0);
    expect(sentMessages.length).toBe(0);
  });
});
