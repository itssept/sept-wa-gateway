import { describe, it, expect } from "bun:test";
import { documentCaption, isLifecycleOnlyOutbound, outboundFailureReason, sanitizeOutboundText } from "../src/routing/sanitizer.ts";
import { OPERATOR_WELCOME_BASE, OPERATOR_WELCOME_PROMPT } from "../src/domain/welcomeMessage.ts";

describe("gw-04-platform-sanitizer: Baileys outbound message sanitization", () => {
  it("Criterion 1: Strips all forbidden patterns (ql.app/l/, internal URLs, Teach SEPT footers, platform tags)", () => {
    const raw = `Here is your order summary for the Chanel Mini Flap.

Invoice Link: https://ql.app/l/Xxfa0Am6
Internal Console: https://prompt.ql.app/project/p-217696ea-9cb2/thread/b44a88d0-ab94-47b2-ae19-d9eceab9e7c6
Thread Citation: <cite>[Thread: "New User Onboarding"](thread://b6a6f01e-0bd6-4b0e-a1c6-db1bf4775c62?message=02068359-f9f3-4f03-8bb8-86bfe8be3398)</cite>
Wiki Link: See [Operating rules](<wiki://Operating rules>) for details.
Artifact Tag: <artifact type="file" identifier="inv-123" />
User Mention: <user_mention id="0e87f95e-af98-4d05-865e-0c66270b4dc9" />

🧠 Teach SEPT → https://ql.app/l/i44VehWS`;

    const sanitized = sanitizeOutboundText(raw);

    // Forbidden patterns must be stripped
    expect(sanitized).not.toContain("https://ql.app");
    expect(sanitized).not.toContain("ql.app/l/");
    expect(sanitized).not.toContain("prompt.ql.app");
    expect(sanitized).not.toContain("Teach SEPT");
    expect(sanitized).not.toContain("thread://");
    expect(sanitized).not.toContain("wiki://");
    expect(sanitized).not.toContain("<artifact");
    expect(sanitized).not.toContain("<user_mention");
    expect(sanitized).not.toContain("<cite>");

    // Text content should be preserved cleanly
    expect(sanitized).toContain("Here is your order summary for the Chanel Mini Flap.");
    expect(sanitized).toContain("See Operating rules for details.");
  });

  it("Criterion 2: Strips varied Teach SEPT footer variations", () => {
    const variants = [
      "Hello operator!\n\nTeach SEPT -> https://ql.app/l/abc12345",
      "Hello operator!\n\n🧠 Teach SEPT → https://ql.app/l/abc12345",
      "Hello operator!\n\n[Teach SEPT](https://ql.app/l/abc12345)",
      "Hello operator!\n\nTeach SEPT: https://prompt.ql.app/teach/123",
      "Hello operator!\n\n🧠 Teach SEPT",
    ];

    for (const v of variants) {
      const sanitized = sanitizeOutboundText(v);
      expect(sanitized).toBe("Hello operator!");
      expect(sanitized).not.toContain("Teach SEPT");
      expect(sanitized).not.toContain("ql.app");
    }
  });

  it("Criterion 3: False-positive test - Legitimate client-facing URLs are NOT stripped", () => {
    const legitimate = `Hi Sarah, here are the links for your piece:
Instagram post: https://instagram.com/p/C-xyz123
DHL tracking: https://www.dhl.com/en/express/tracking.html?AWB=1234567890
Stripe payment: https://buy.stripe.com/test_123456
Chanel official: https://www.chanel.com/us/fashion/p/A69900Y0407494305/mini-classic-handbag/

Let me know if you would like me to reserve it!`;

    const sanitized = sanitizeOutboundText(legitimate);

    expect(sanitized).toContain("https://instagram.com/p/C-xyz123");
    expect(sanitized).toContain("https://www.dhl.com/en/express/tracking.html?AWB=1234567890");
    expect(sanitized).toContain("https://buy.stripe.com/test_123456");
    expect(sanitized).toContain("https://www.chanel.com/us/fashion/p/A69900Y0407494305/mini-classic-handbag/");
    expect(sanitized).toBe(legitimate.trim());
  });

  it("strips ephemeral media bridge bearer URLs and keeps other links", () => {
    const token = "ab".repeat(24);
    const raw = `Here is the bag.\nhttp://64.225.89.130:8790/api/v1/ephemeral-media/${token}\nhttps://www.chanel.com/us/`;
    const sanitized = sanitizeOutboundText(raw);
    expect(sanitized).not.toContain("ephemeral-media");
    expect(sanitized).not.toContain(token);
    expect(sanitized).toContain("Here is the bag.");
    expect(sanitized).toContain("https://www.chanel.com/us/");
  });

  it("drops a PromptQL cancel banner, internal URLs, and run ids", () => {
    const live = `⚠️ SEPT's run was cancelled before it could finish.

https://ql.app/l/AbCdEf12
https://prompt.ql.app/project/p-217696ea-9cb2/thread/b44a88d0-ab94-47b2-ae19-d9eceab9e7c6
https://data.prompt.ql.app/promptql/mcp-server/mcp
ql.app/l/BareLink99
[View run](https://ql.app/l/Markdown1)
run id: 3f2a1111-2222-4333-8444-555566667777
run_01HZZZZZZZZ
Status: interrupted_due_to_new_trigger`;

    const sanitized = sanitizeOutboundText(live);
    expect(sanitized).toBe("");
    expect(sanitized).not.toContain("ql.app");
    expect(sanitized).not.toContain("cancelled");
    expect(sanitized).not.toContain("3f2a1111");
    expect(sanitized).not.toContain("interrupted_due_to_new_trigger");
    expect(sanitized).not.toContain("run_01HZ");
    expect(isLifecycleOnlyOutbound(live)).toBe(true);
    expect(outboundFailureReason(live)).toBe("interrupted_due_to_new_trigger");
  });

  it("keeps concierge copy when a cancel banner is appended", () => {
    const raw = `Invoice is ready for Noor.

⚠️ SEPT's run was cancelled before it could finish.
https://ql.app/l/ZzTop99

Total $5,000.
The shipment was cancelled before it could finish customs.
https://www.dhl.com/track/123`;

    const sanitized = sanitizeOutboundText(raw);
    expect(sanitized).toContain("Invoice is ready for Noor.");
    expect(sanitized).toContain("Total $5,000.");
    expect(sanitized).toContain("The shipment was cancelled before it could finish customs.");
    expect(sanitized).toContain("https://www.dhl.com/track/123");
    expect(sanitized).not.toContain("ql.app");
    expect(sanitized).not.toContain("run was cancelled");
    expect(isLifecycleOnlyOutbound(raw)).toBe(false);
  });

  it("strips schemeless permalinks and markdown links to ql.app without touching other hosts", () => {
    const raw = "Track it here: [View run](https://ql.app/l/abc) and ql.app/l/def plus https://instagram.com/p/ok and https://sql.app/docs";
    const sanitized = sanitizeOutboundText(raw);
    expect(sanitized).not.toContain("ql.app/l");
    expect(sanitized).not.toContain("https://ql.app");
    expect(sanitized).not.toContain("View run");
    expect(sanitized).toContain("https://instagram.com/p/ok");
    expect(sanitized).toContain("https://sql.app/docs");
    expect(sanitized).toContain("Track it here:");
  });

  it("Criterion 4: The welcome template from Bot 1 passes the sanitizer unchanged", () => {
    const sanitizedBase = sanitizeOutboundText(OPERATOR_WELCOME_BASE);
    expect(sanitizedBase).toBe(OPERATOR_WELCOME_BASE.trim());

    const sanitizedPrompt = sanitizeOutboundText(OPERATOR_WELCOME_PROMPT);
    expect(sanitizedPrompt).toBe(OPERATOR_WELCOME_PROMPT.trim());
  });

  it("Criterion 5: Strips SEPT/PromptQL cancelled-run platform notices", () => {
    const variants = [
      "⚠️ SEPT's run was cancelled before it could finish.",
      "SEPT's run was cancelled before it could finish.",
      "Confirmed size 38 with sourcer.\n\n⚠️ SEPT's run was cancelled before it could finish.",
      "PromptQL run was cancelled.",
      "PromptQL run cancelled before it could finish.",
      "⚠️ SEPT’s run was cancelled before it could finish.",
    ];
    for (const v of variants) {
      const sanitized = sanitizeOutboundText(v);
      expect(sanitized).not.toMatch(/cancelled before it could finish/i);
      expect(sanitized).not.toMatch(/SEPT'?s run was cancelled/i);
      expect(sanitized).not.toMatch(/PromptQL run/i);
    }
    const withContent = sanitizeOutboundText(
      "Re-confirm Louboutin Blue Me Dolly size 38 with sourcer before client quote.\n\n⚠️ SEPT's run was cancelled before it could finish.",
    );
    expect(withContent).toContain("Re-confirm Louboutin Blue Me Dolly size 38");
    expect(withContent).not.toMatch(/cancelled before it could finish/i);
    expect(isLifecycleOnlyOutbound("PromptQL run was cancelled.")).toBe(true);
    expect(isLifecycleOnlyOutbound("⚠️ SEPT's run was cancelled before it could finish.")).toBe(true);
  });

  it("strips Markdown headers, emphasis, and code spans while keeping the words", () => {
    const raw = `### Commercial invoice

**Client:** Noor Al-Sabah
*Piece:* Chanel Mini Flap
Total: \`$5,000\`
~~hold~~ confirmed

\`\`\`json
{ "sku": "ABC" }
\`\`\`

_Please review the attached invoice._

Track: [DHL](https://www.dhl.com/track/123)
Order #4481 stays
https://cdn.example.com/awb_12345_label`;

    const sanitized = sanitizeOutboundText(raw);
    expect(sanitized).not.toContain("###");
    expect(sanitized).not.toContain("**");
    expect(sanitized).not.toContain("`");
    expect(sanitized).not.toContain("```");
    expect(sanitized).not.toContain("~~");
    expect(sanitized).not.toContain("_Please");
    expect(sanitized).not.toContain("[DHL]");
    expect(sanitized).toContain("Commercial invoice");
    expect(sanitized).toContain("Client: Noor Al-Sabah");
    expect(sanitized).toContain("Piece: Chanel Mini Flap");
    expect(sanitized).toContain("Total: $5,000");
    expect(sanitized).toContain("hold confirmed");
    expect(sanitized).toContain('{ "sku": "ABC" }');
    expect(sanitized).toContain("Please review the attached invoice.");
    expect(sanitized).toContain("DHL (https://www.dhl.com/track/123)");
    expect(sanitized).toContain("Order #4481 stays");
    expect(sanitized).toContain("https://cdn.example.com/awb_12345_label");
  });

  it("keeps welcome asterisks that are bullets, not emphasis", () => {
    expect(sanitizeOutboundText(OPERATOR_WELCOME_BASE)).toBe(OPERATOR_WELCOME_BASE.trim());
    const bullets = OPERATOR_WELCOME_BASE.split("\n").filter((line) => line.startsWith("* ")).join("\n");
    expect(sanitizeOutboundText(bullets)).toBe(bullets);
  });

  it("keeps a long text reply intact and shortens only a document caption", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Spec line ${i} about the piece and its condition.`);
    const body = lines.join("\n");
    expect(sanitizeOutboundText(body)).toBe(body);

    const caption = documentCaption(body);
    const kept = caption.split("\n").filter((line) => line.trim().length > 0);
    expect(kept.length).toBeLessThanOrEqual(4);
    expect(caption.length).toBeLessThanOrEqual(320);
    expect(caption.startsWith("Spec line 0")).toBe(true);
    expect(caption).not.toContain("Spec line 9");

    const noted = documentCaption(`${body}\n\n(Attachment too large to send)`);
    expect(noted.endsWith("(Attachment too large to send)")).toBe(true);
    expect(noted).not.toContain("Spec line 9");

    const short = "Here is the commercial invoice for your deal.\nKindly let me know once reviewed.";
    expect(documentCaption(short)).toBe(short);
  });

  it("keeps the operator welcome whole when it prefixes a document caption", () => {
    const answer = Array.from({ length: 10 }, (_, i) => `Spec line ${i} about the piece.`).join("\n");
    const full = sanitizeOutboundText(`${OPERATOR_WELCOME_BASE}\n\n${answer}`);
    const caption = documentCaption(full, OPERATOR_WELCOME_BASE);
    expect(caption.startsWith(OPERATOR_WELCOME_BASE.trim())).toBe(true);
    expect(caption).toContain("* Remember pieces as they come in");
    expect(caption).toContain("Spec line 0");
    expect(caption).not.toContain("Spec line 9");
  });
});