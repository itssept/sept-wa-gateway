import { describe, expect, it } from "bun:test";
import { VerifiedReportingEngine, type OutboundMessageState } from "../src/domain/reportingGuardrails.ts";

describe("VerifiedReportingEngine — Only report what actually happened", () => {
  describe("Suite 1: Message Delivery Truthfulness", () => {
    it("reports 'queued' when message is queued", () => {
      const msg: OutboundMessageState = {
        messageId: "msg-001",
        recipientJid: "447100000000@s.whatsapp.net",
        state: "queued",
        gatewayAckReceived: false,
      };
      expect(VerifiedReportingEngine.getDeliveryStatusReport(msg)).toContain("queued");
    });

    it("reports 'attempting to send' when unconfirmed", () => {
      const msg: OutboundMessageState = {
        messageId: "msg-002",
        recipientJid: "447100000000@s.whatsapp.net",
        state: "attempting_to_send",
        gatewayAckReceived: false,
      };
      expect(VerifiedReportingEngine.getDeliveryStatusReport(msg)).toContain("attempting to send");
    });

    it("reports 'Sent' ONLY when gateway delivery ack is confirmed", () => {
      const msg: OutboundMessageState = {
        messageId: "msg-003",
        recipientJid: "447100000000@s.whatsapp.net",
        state: "sent",
        gatewayAckReceived: true,
      };
      expect(VerifiedReportingEngine.getDeliveryStatusReport(msg)).toContain("Sent (Delivery Confirmed)");
    });

    it("reports 'failed to send' upon gateway dispatch failure", () => {
      const msg: OutboundMessageState = {
        messageId: "msg-004",
        recipientJid: "447100000000@s.whatsapp.net",
        state: "failed_to_send",
        gatewayAckReceived: false,
        failureReason: "network disconnect",
      };
      expect(VerifiedReportingEngine.getDeliveryStatusReport(msg)).toContain("failed to send");
    });
  });

  describe("Suite 2: Search Execution Truthfulness", () => {
    it("reports search did not run when searchExecuted is false", () => {
      expect(VerifiedReportingEngine.reportSearchResult(false, 0, "Hermes Kelly 25")).toBe(
        'Search has not been run for query "Hermes Kelly 25".'
      );
    });

    it("reports 'No listing found' ONLY after actual execution", () => {
      expect(VerifiedReportingEngine.reportSearchResult(true, 0, "Hermes Kelly 25")).toBe(
        'Search executed: No listing found for "Hermes Kelly 25".'
      );
    });

    it("reports found listings accurately", () => {
      expect(VerifiedReportingEngine.reportSearchResult(true, 2, "Chanel Classic Flap")).toBe(
        'Search executed: Found 2 listing(s) for "Chanel Classic Flap".'
      );
    });
  });

  describe("Suite 3: Voice Note Anti-Fabrication Invariant", () => {
    it("returns exact invariant string on audio processing failure", () => {
      expect(VerifiedReportingEngine.handleVoiceNoteTranscription(false)).toBe(
        "I couldn't process this voice note."
      );
    });

    it("strictly resists adversarial user pushback", () => {
      expect(VerifiedReportingEngine.handlePushbackOnAudio()).toBe(
        "I couldn't process this voice note."
      );
    });
  });
});
