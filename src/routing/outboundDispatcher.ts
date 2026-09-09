/**
 * OutboundDispatcher — outbound half of the message flow.
 *
 *  1. Block on get_latest_promptql_thread_response (re-called on `analyzing`
 *     until a bounded deadline) for the bot's answer.
 *  2. On completed -> that message. On declined_approval -> a notice that the
 *     action needs console approval (we auto-declined). On failed -> mark failed.
 *  3. Resolve the originating chat from the durable dispatch record.
 *  4. Resolve any inline-referenced artifacts, then deliver the text and files
 *     together: the reply text (plus a short note about any artifact that could
 *     not be attached) rides the first document as its caption; extra artifacts
 *     follow as their own documents. With no artifact, the text is sent alone.
 *  5. Send through Baileys via the anti-ban queue.
 *  6. Record delivery success/failure against the outbound idempotency log using
 *     the claim token (retry-safe, fenced against a lost claim).
 */

import type { ChatBotRepo } from "../storage/chatBotRepo.ts";
import { isGroupJid } from "../util.ts";
import {
  parseArtifactRefs,
  type PromptQlAdapter, type ArtifactOutcome, type ArtifactFailureReason,
  type ResponseArtifact,
} from "../promptql/promptqlAdapter.ts";
import type { McpWorkflowRepo } from "../storage/mcpWorkflowRepo.ts";
import type { OutboundLog } from "../storage/outboundLog.ts";
import type { WhatsAppConnection } from "../whatsapp/socket.ts";
import type { PacingProfile } from "../whatsapp/antiBan.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import { maskJid } from "../util.ts";

export interface DispatchInput {
  workflowId: string;
  connectionId: string;
  chatJid: string;
  shopperId: string;
  idempotencyKey: string;
  claimToken: string;
  threadId: string;
  threadEventId: string | null;
  /** Routing may opt PA replies to clients into the extra pause. */
  pacingProfile?: PacingProfile;
  credentialRole?: "shopper" | "pa";
}

export class OutboundDispatcher {
  constructor(
    private readonly adapter: PromptQlAdapter,
    private readonly workflows: McpWorkflowRepo,
    private readonly outboundLog: OutboundLog,
    private readonly connection: WhatsAppConnection,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly chatBots: ChatBotRepo,
  ) {}

  async dispatch(input: DispatchInput): Promise<void> {
    const deadline = Date.now() + this.config.mcp.responseMaxMs;

    let answer: string | null = null;
    // Only a completed response can carry artifacts. A declined-approval notice
    // is our own boilerplate, so never scan it for <artifact> tags.
    let completed = false;
    let responseArtifacts: ResponseArtifact[] = [];
    try {
      const res = await this.adapter.waitForResponse(
        { shopperId: input.shopperId, role: input.credentialRole ?? "shopper" },
        { threadId: input.threadId, threadEventId: input.threadEventId },
        deadline,
      );
      if (res.status === "failed") {
        this.fail(input, res.message);
        return;
      }
      // completed or declined_approval both produce a message to send back.
      answer = res.message;
      completed = res.status === "completed";
      if (res.status === "completed") responseArtifacts = res.artifacts;
    } catch (err) {
      this.fail(input, `PromptQL error: ${String(err)}`);
      return;
    }

    // Split inline <artifact/> references off the completed text. The stripped
    // text becomes the reply caption; the refs are fetched and attached with it.
    const { text: strippedAnswer, refs } = completed && answer
      ? parseArtifactRefs(answer)
      : { text: answer ?? "", refs: [] };

    const canSend = () => !isGroupJid(input.chatJid) ||
      this.chatBots.get(input.connectionId, input.chatJid)?.relayPausedAt == null;
    if (!canSend()) {
      this.fail(input, "chat_left");
      return;
    }

    const log = this.log.child({ corrId: input.idempotencyKey, chatJid: maskJid(input.chatJid) });

    // Resolve the referenced artifacts BEFORE sending so text + files go out
    // together. Each outcome is either sendable bytes or a reason it was dropped.
    let outcomes: ArtifactOutcome[] = [];
    if (refs.length > 0) {
      try {
        outcomes = await this.adapter.resolveArtifacts(
          { shopperId: input.shopperId, role: input.credentialRole ?? "shopper" },
          responseArtifacts,
          refs,
          this.config.mcp.maxArtifactBytes,
        );
      } catch (err) {
        // A resolution-wide failure (e.g. session lost) drops every artifact but
        // must not sink the text reply — note them all as unavailable.
        log.warn("artifact resolution failed", { err });
        outcomes = refs.map((r) => ({ ok: false, identifier: r.identifier, reason: "unavailable" as const }));
      }
    }
    const artifacts = outcomes.flatMap((o) => (o.ok ? [o.artifact] : []));
    const failures = outcomes.flatMap((o) => (o.ok ? [] : [o.reason]));

    // Caption = the reply text plus a short note about anything we couldn't
    // attach. With no artifacts and no failures, this is just the text.
    const caption = withFailureNote(strippedAnswer.trim(), failures);
    if (caption === "" && artifacts.length === 0) {
      // Nothing to say and nothing to attach — treat like an empty response.
      this.fail(input, "empty response");
      return;
    }

    this.workflows.markDone(input.workflowId, caption || `(${artifacts.length} attachment(s))`);

    // The first send is the reply that satisfies the inbound claim. When there
    // is an artifact, the text rides it as a caption; otherwise it goes as text.
    const [first, ...rest] = artifacts;
    try {
      const ref = first
        ? await this.connection.sendDocument(
            input.chatJid,
            { bytes: first.bytes, fileName: first.fileName, mimeType: first.mimeType, caption: caption || undefined },
            {
              pacingProfile: input.pacingProfile,
              beforeSend: canSend,
              onMessageId: (id) => this.outboundLog.recordGatewayMessage(input.connectionId, input.chatJid, id),
            },
          )
        : await this.connection.sendText(input.chatJid, caption, {
            pacingProfile: input.pacingProfile,
            beforeSend: canSend,
            onMessageId: (id) => this.outboundLog.recordGatewayMessage(input.connectionId, input.chatJid, id),
          });
      const ok = this.outboundLog.markSent(
        input.connectionId,
        input.idempotencyKey,
        input.claimToken,
        { chatJid: input.chatJid, messageRef: ref },
      );
      if (ok) log.info("outbound sent", { messageRef: ref, attachments: artifacts.length, droppedArtifacts: failures.length });
      else log.warn("outbound claim lost");
    } catch (err) {
      if (err instanceof Error && err.message === "chat_left") {
        this.fail(input, "chat_left");
        return;
      }
      this.outboundLog.markFailed(input.connectionId, input.idempotencyKey, input.claimToken);
      log.error("outbound send failed", { err });
      // We won't reach the follow-up loop, so release the pending bytes here.
      for (const a of rest) a.bytes = Buffer.alloc(0);
      return;
    } finally {
      // The first artifact's bytes are done either way (sent or failed).
      if (first) first.bytes = Buffer.alloc(0);
    }

    // Extra artifacts follow as their own documents (best-effort). The reply is
    // already sent, so a failure here never fails the reply.
    for (const artifact of rest) {
      if (!canSend()) {
        log.warn("artifact relay stopped: chat_left");
        break;
      }
      try {
        const ref = await this.connection.sendDocument(
          input.chatJid,
          { bytes: artifact.bytes, fileName: artifact.fileName, mimeType: artifact.mimeType },
          {
            pacingProfile: input.pacingProfile,
            beforeSend: canSend,
            onMessageId: (id) => this.outboundLog.recordGatewayMessage(input.connectionId, input.chatJid, id),
          },
        );
        log.info("artifact sent", { messageRef: ref, sizeBytes: artifact.bytes.length });
      } catch (err) {
        if (err instanceof Error && err.message === "chat_left") {
          log.warn("artifact relay stopped: chat_left");
          break;
        }
        log.warn("artifact send failed", { err });
      } finally {
        artifact.bytes = Buffer.alloc(0);
      }
    }
  }

  private fail(input: DispatchInput, reason: string): void {
    this.workflows.markFailed(input.workflowId);
    this.outboundLog.markFailed(input.connectionId, input.idempotencyKey, input.claimToken);
    this.log.warn("outbound no result", {
      corrId: input.idempotencyKey,
      chatJid: maskJid(input.chatJid),
      workflowId: input.workflowId,
      reason,
    });
  }
}

/**
 * Append a short, user-facing note about any artifact that could not be
 * attached, in brackets on its own line. Failures are grouped by reason and
 * counted, e.g. "(Attachment too large to send)" or
 * "(2 attachments couldn't be retrieved)". Returns the text unchanged when
 * there were no failures.
 */
function withFailureNote(text: string, failures: ArtifactFailureReason[]): string {
  if (failures.length === 0) return text;
  const counts = new Map<ArtifactFailureReason, number>();
  for (const r of failures) counts.set(r, (counts.get(r) ?? 0) + 1);
  const phrases: string[] = [];
  for (const [reason, n] of counts) {
    const noun = n === 1 ? "attachment" : `${n} attachments`;
    phrases.push(reason === "too_large"
      ? `${noun} too large to send`
      : `${noun} couldn't be retrieved`);
  }
  // Capitalize the assembled note so it reads the same regardless of which
  // failure comes first, e.g. "(Attachment too large to send)".
  const joined = phrases.join("; ");
  const note = `(${joined.charAt(0).toUpperCase()}${joined.slice(1)})`;
  return text ? `${text}\n\n${note}` : note;
}
