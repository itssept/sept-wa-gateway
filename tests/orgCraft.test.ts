import { expect, test, afterEach } from "bun:test";
import { makeTestApp } from "./helpers.ts";
import { InboundRouter } from "../src/routing/inboundRouter.ts";
import {
  DEFAULT_CRAFT_PLAYBOOKS,
  assertCraftOnly,
  formatCraftSystemInstruction,
  loadOrgCraftSystemInstruction,
  operatorRequestsInvoice,
  type OrgCraftPlaybook,
} from "../src/craft/orgCraft.ts";
import type { InboundMessage } from "../src/whatsapp/socket.ts";
import type { PostingIdentity } from "../src/promptql/promptqlAdapter.ts";

test("invoice asks are detected without treating a question or the bridge boilerplate as one", () => {
  expect(operatorRequestsInvoice("Invoice this")).toBe(true);
  expect(operatorRequestsInvoice("@SEPT invoice this")).toBe(true);
  expect(operatorRequestsInvoice("PDF invoice for the Chanel")).toBe(true);
  expect(operatorRequestsInvoice("What invoice number did we use?")).toBe(false);
  const bridge = "Fetch each URL for item identification / invoice generation.\nOperator message:\nHello";
  expect(operatorRequestsInvoice(bridge)).toBe(false);
  expect(operatorRequestsInvoice(`${bridge.replace("Hello", "Invoice this")}`)).toBe(true);
});

test("default seeds format without PII reject", () => {
  for (const p of DEFAULT_CRAFT_PLAYBOOKS) assertCraftOnly(p);
  const text = formatCraftSystemInstruction(DEFAULT_CRAFT_PLAYBOOKS);
  expect(text).toContain("ORG SHARED CRAFT");
  expect(text).toContain("invoice_pdf_luxury_caption");
  expect(text).toContain(
    "run deal_execution_flow.generate_invoice_pdf and return the application/pdf artifact instead of a link.",
  );
  expect(text).toContain("A permalink is not an invoice.");
  expect(text).toContain("sept_multimodal_recognition");
  expect(text).toContain("deal_execution_flow.py");
  expect(text).toContain("function generate_invoice_pdf");
  expect(text).not.toContain("SEPT LUXURY CONCIERGE");
  expect(text).toContain("one short plain sentence");
  expect(text).toContain("No markdown headers/bullets/code ticks.");
  expect(text).toContain("An HTML chip is not an invoice.");
  expect(text).toContain("invoice this");
  expect(text).toContain("content_type application/pdf");
  expect(text).toContain("item_id_grounded_search");
  expect(text).toContain("sizing_eu_narrow_notes");
  expect(text).toContain("logistics_truth_gate");
  expect(text).toContain("12 Park Street");
  expect(text).toContain("Do not say it is already done.");
  expect(text).toContain("only state what is visible");
  expect(text).toContain("Métiers d'Art");
  expect(text).toContain("sold-out status");
  expect(text).toContain("resale band");
  expect(text).toContain("delivery confirmed");
  expect(text).not.toMatch(/\b(client_|phone|price|margin|quote|bank_)\b/i);
});

test("rejects PII-shaped playbook", () => {
  const bad: OrgCraftPlaybook = {
    category: "procedural_craft",
    playbook_key: "leak",
    title: "nope",
    instructions: "Call the client_phone tomorrow",
  };
  expect(() => assertCraftOnly(bad)).toThrow(/PII-shaped/);
  expect(formatCraftSystemInstruction([bad])).toBe("");
});

test("load respects enable flag and inline override", () => {
  expect(loadOrgCraftSystemInstruction({ enabled: false, useDefaults: true })).toBeUndefined();
  const inline = loadOrgCraftSystemInstruction({
    enabled: true,
    inlineInstruction: "ORG SHARED CRAFT\nUse branded PDF only.",
  });
  expect(inline).toContain("branded PDF");
  expect(inline).toContain("function generate_invoice_pdf");
  expect(inline).toContain("application/pdf");
  const blocked = loadOrgCraftSystemInstruction({
    enabled: true,
    inlineInstruction: "Send the supplier_phone and the quote.",
    useDefaults: true,
  });
  expect(blocked).toBeUndefined();
  const defaults = loadOrgCraftSystemInstruction({ enabled: true, useDefaults: true });
  expect(defaults).toContain("invoice_pdf_luxury_caption");
  expect(defaults).toContain(
    "run deal_execution_flow.generate_invoice_pdf and return the application/pdf artifact instead of a link.",
  );
});

test("load from JSON file stub", () => {
  const filePlaybooks: OrgCraftPlaybook[] = [
    {
      category: "market_tags",
      playbook_key: "market_tags_ref",
      title: "Typical market tags",
      instructions: "Share only typical market/reference tag craft, never a named deal.",
    },
  ];
  const text = loadOrgCraftSystemInstruction({
    enabled: true,
    filePath: "/tmp/craft.json",
    useDefaults: false,
    readFileSync: () => JSON.stringify(filePlaybooks),
  });
  expect(text).toContain("market_tags_ref");
  expect(text).toContain("function generate_invoice_pdf");
  expect(text).not.toMatch(/\b(client_|phone|price|margin|quote|bank_)\b/i);
});

const apps: Array<{ db: { close(): void } }> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

test("ask receives org craft as systemInstruction and not the message body", async () => {
  const app = makeTestApp();
  apps.push(app);
  const { ctx } = app;
  ctx.gatewaySettings.set("client-token", "common-room");
  const shopper = ctx.shoppers.register("Yara", "+97336663062", "operator-yara").shopper;
  ctx.credentials.setActive(shopper.id, `shopper-${shopper.id}`);
  const craft = loadOrgCraftSystemInstruction({ enabled: true, useDefaults: true })!;
  const calls: Array<{ identity: PostingIdentity; input: { systemInstruction?: string; query: string } }> = [];
  const router = new InboundRouter(
    ctx.resolver,
    { ask: async (identity: PostingIdentity, input: { systemInstruction?: string; query: string }) => {
      calls.push({ identity, input });
      return { threadId: "bot", threadEventId: "evt" };
    } } as never,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    { dispatch: async () => undefined, dispatchDirectText: async () => undefined, notifyChat: async () => undefined } as never,
    ctx.audit,
    ctx.log,
    {
      settings: ctx.gatewaySettings,
      messages: ctx.messages,
      getGroup: async () => null,
      prepareHistory: async () => null,
      relayUnregisteredChats: true,
      inboundDebounceMs: 0,
      orgCraftSystemInstruction: craft,
    },
  );
  const msg: InboundMessage = {
    connectionId: "test-conn",
    chatJid: "97336663062@s.whatsapp.net",
    senderJid: "97336663062@s.whatsapp.net",
    senderPhoneE164: "+97336663062",
    pushName: "Yara",
    messageId: "craft-1",
    ts: Date.now(),
    text: "invoice for the chanel please",
    msgType: "text",
    mediaStatus: "none",
    media: null,
    isGroup: false,
    fromMe: false,
    mentionsSelf: false,
  };
  await router.handle(msg);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.systemInstruction).toContain(craft);
  expect(calls[0]!.input.systemInstruction).toContain("THIS TURN IS AN INVOICE REQUEST");
  expect(calls[0]!.input.systemInstruction).toContain(
    "run deal_execution_flow.generate_invoice_pdf and return the application/pdf artifact instead of a link.",
  );
  expect(calls[0]!.input.systemInstruction).not.toContain("chanel");
  expect(calls[0]!.input.systemInstruction).not.toContain("+973");
  expect(calls[0]!.input.query).toBe("invoice for the chanel please");
});
