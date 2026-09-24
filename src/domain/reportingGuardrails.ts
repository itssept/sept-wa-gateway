/**
 * ReportingGuardrails — Enforces verified reporting invariants for SEPT.
 *
 * Invariants:
 *  1. Never claim "Sent" without verified delivery confirmation from the gateway.
 *     State must be "queued" or "attempting to send" while in transit, and "failed to send" on error.
 *  2. "No listing found" requires a genuine search execution against the catalog/network.
 *     If no search was executed, explicitly report that search has not been run.
 *  3. Voice note audio failure returns exact invariant: "I couldn't process this voice note."
 *     Strictly refuse speculation or hallucination under user pushback.
 */

export type DeliveryState = "queued" | "attempting_to_send" | "sent" | "failed_to_send";

export interface OutboundMessageState {
  messageId: string;
  recipientJid: string;
  state: DeliveryState;
  gatewayAckReceived: boolean;
  failureReason?: string;
}

export class VerifiedReportingEngine {
  /**
   * Determine truthful message delivery status string.
   */
  static getDeliveryStatusReport(msg: OutboundMessageState): string {
    if (msg.gatewayAckReceived && msg.state === "sent") {
      return `Message ${msg.messageId} to ${msg.recipientJid}: Sent (Delivery Confirmed)`;
    }
    if (msg.state === "failed_to_send") {
      return `Message ${msg.messageId} to ${msg.recipientJid}: failed to send (${msg.failureReason || "gateway error"})`;
    }
    if (msg.state === "queued") {
      return `Message ${msg.messageId} to ${msg.recipientJid}: queued`;
    }
    return `Message ${msg.messageId} to ${msg.recipientJid}: attempting to send`;
  }

  /**
   * Validate search execution before reporting outcome.
   */
  static reportSearchResult(searchExecuted: boolean, resultsCount: number, query: string): string {
    if (!searchExecuted) {
      return `Search has not been run for query "${query}".`;
    }
    if (resultsCount === 0) {
      return `Search executed: No listing found for "${query}".`;
    }
    return `Search executed: Found ${resultsCount} listing(s) for "${query}".`;
  }

  /**
   * Handle voice note processing outcome.
   */
  static handleVoiceNoteTranscription(audioProcessed: boolean, transcript?: string): string {
    if (!audioProcessed || !transcript || transcript.trim().length === 0) {
      return "I couldn't process this voice note.";
    }
    return transcript;
  }

  /**
   * Strict refusal against user pushback requesting speculation on unprocessable audio.
   */
  static handlePushbackOnAudio(): string {
    return "I couldn't process this voice note.";
  }
}
