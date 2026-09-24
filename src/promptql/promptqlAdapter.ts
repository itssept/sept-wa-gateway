/**
 * PromptQlAdapter — maps gateway operations to the VERIFIED PromptQL MCP tools.
 *
 * PromptQL's product concept is a "bot"; the MCP wire still uses `thread_id`
 * (compatibility-first naming migration). We say "bot" in our domain and keep
 * `thread_id` on the wire.
 *
 * Flow (verified live):
 *   ask_promptql({query, thread_id?, room_name?})
 *     -> { thread_id, thread_event_id }
 *   get_latest_promptql_thread_response({thread_id, thread_event_id})  [blocking]
 *     -> { status, message, approvals[] }
 *        status: completed | analyzing (re-call) | waiting_approval
 *
 * Approvals are auto-declined in this gateway (respond_to_promptql_approval)
 * and the caller notifies the shopper — the gateway never auto-approves a
 * sensitive action on behalf of an unauthenticated WhatsApp sender.
 */

import { z } from "zod";
import type { Config } from "../config.ts";
import type { DownloadedMedia } from "../whatsapp/media.ts";
import { rootLogger, type Logger } from "../logger.ts";
import { McpSession, McpError } from "./mcpClient.ts";

const TOOL_ASK = "ask_promptql";
const TOOL_WAIT = "get_latest_promptql_thread_response";
const TOOL_RESPOND_APPROVAL = "respond_to_promptql_approval";
// download_promptql_artifact is the ONLY tool that returns artifact CONTENT.
// get_promptql_artifact / list_..._metadata return metadata only (verified live:
// get_promptql_artifact relayed a metadata JSON dump, not the bytes).
const TOOL_DOWNLOAD_ARTIFACT = "download_promptql_artifact";

export interface AskResult {
  threadId: string;
  threadEventId: string | null;
}

const PromptQlFileInputSchema = z
  .object({
    file_name: z.string().trim().min(1).max(255)
      .regex(/^[^\/\\\x00-\x1f\x7f\u2028\u2029]+$/)
      .refine((name) => name !== "." && name !== ".."),
    mime_type: z.string().min(1).max(255)
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n\x00-\x1f\x7f]*)?$/),
    content_base64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((content) => content.length % 4 === 0, "Invalid base64 length"),
  })
  .strict();

const PromptQlFilesSchema = z.array(PromptQlFileInputSchema).max(1);

export type PromptQlFileInput = z.infer<typeof PromptQlFileInputSchema>;

/** Convert already-downloaded bytes for either a live or replayed post.
 * The caller supplies a safe fallback name and releases the media after ask.
 */
export function promptQlFileFromMedia(
  media: DownloadedMedia,
  fallbackFileName: string,
): PromptQlFileInput {
  const bytes = z.instanceof(Buffer).parse(media.bytes);
  return PromptQlFileInputSchema.parse({
    file_name: media.fileName ?? fallbackFileName,
    mime_type: media.mime ?? "application/octet-stream",
    content_base64: bytes.toString("base64"),
  });
}

/**
 * An artifact referenced by the final response, fetched and ready to relay to
 * WhatsApp as a document attachment. Bytes are transient — the caller sends
 * them and never persists them, exactly like inbound media.
 */
export interface ResolvedArtifact {
  identifier: string;
  title: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/** Why a referenced artifact could not be attached. The caller surfaces this to
 *  the user as a short note; keep the set small so wording stays consistent. */
export type ArtifactFailureReason = "too_large" | "unavailable";

/** The per-reference outcome of resolveArtifacts: either sendable bytes or a
 *  reason the artifact was dropped. Order matches the referenced order. */
export type ArtifactOutcome =
  | { ok: true; artifact: ResolvedArtifact }
  | { ok: false; identifier: string; reason: ArtifactFailureReason };

/** A reference parsed out of the final response's inline <artifact .../> tags. */
export interface ArtifactRef {
  identifier: string;
  type: string | null;
}

// One entry of the completed response's `artifacts[]`. Verified live: it carries
// the inline `identifier`, plus an `artifact_reference` with the real UUID
// `artifact_id` and a zero-based integer `version` — everything needed to
// download the content directly, no metadata-list call or slug matching.
const ResponseArtifactSchema = z.object({
  identifier: z.string().min(1),
  title: z.string().nullish(),
  artifact_type: z.string().nullish(),
  artifact_reference: z.object({
    artifact_id: z.string().min(1),
    version: z.number().int().nonnegative().nullish(),
  }),
}).passthrough();
export type ResponseArtifact = z.infer<typeof ResponseArtifactSchema>;

/** Parse the completed response's `artifacts[]`; unrecognised entries are dropped. */
function parseResponseArtifacts(raw: unknown): ResponseArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: ResponseArtifact[] = [];
  for (const entry of raw) {
    const parsed = ResponseArtifactSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// A self-closing tag the bot embeds in its final text, e.g.
//   <artifact type="text" identifier="simple-text" />
// Attribute order is not guaranteed, so match identifier and type independently
// within a single tag. Only the identifier is required to fetch the artifact.
const ARTIFACT_TAG = /<artifact\b[^>]*\/?>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
const IDENTIFIER_ATTR = ATTR("identifier");
const TYPE_ATTR = ATTR("type");

/**
 * Parse the inline artifact references out of a final response and return the
 * references plus the text with those tags removed. We relay ONLY artifacts the
 * bot explicitly referenced inline; duplicates (same identifier) collapse to the
 * first occurrence. The stripped text is what we send to WhatsApp.
 */
export function parseArtifactRefs(text: string): { text: string; refs: ArtifactRef[] } {
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ARTIFACT_TAG)) {
    const tag = match[0];
    const identifier = IDENTIFIER_ATTR.exec(tag)?.[1]?.trim();
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    refs.push({ identifier, type: TYPE_ATTR.exec(tag)?.[1]?.trim() || null });
  }
  // Drop the tags and tidy the whitespace they leave behind so the sent text
  // reads naturally without the machine markup. A tag that owns its whole line
  // (only whitespace around it) takes that line with it; an inline tag mid-text
  // is removed in place, leaving the surrounding words spaced as written.
  const ownLine = new RegExp(`^[ \\t]*${ARTIFACT_TAG.source}[ \\t]*$`, "gim");
  const stripped = text
    .replace(ownLine, "\x00") // mark whole-line tags for their newline to go too
    .replace(ARTIFACT_TAG, "") // remaining inline tags: remove in place
    .replace(/\n?\x00\n?/g, "\n") // collapse a marked line into a single break
    .replace(/ {2,}/g, " ") // squeeze the gap an inline tag left between words
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: stripped, refs };
}


// download_promptql_artifact returns standard MCP content blocks. The block that
// carries the artifact bytes varies by type:
//   - text            -> { type:"text", text }
//   - image / audio   -> { type:"image"|"audio", data:<base64>, mimeType }
//   - html/table/viz/
//     file / binary   -> { type:"resource", resource:{ text | blob:<base64>, mimeType, uri } }
// We take the FIRST block that yields bytes. `uri` is an artifact:// resource id,
// not content, so it is ignored for the payload.
const McpResourceSchema = z.object({
  text: z.string().optional(),
  blob: z.string().optional(),
  mimeType: z.string().optional(),
  uri: z.string().optional(),
}).passthrough();
const McpContentBlockSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  resource: McpResourceSchema.optional(),
}).passthrough();
const McpResultSchema = z.object({
  content: z.array(McpContentBlockSchema).optional(),
}).passthrough();

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeBase64(s: string): Buffer | null {
  if (!BASE64_RE.test(s) || s.length % 4 !== 0) return null;
  return Buffer.from(s, "base64");
}

/** Pull the artifact bytes + mime out of an MCP tool result's content blocks. */
function bytesFromMcpResult(raw: unknown): { bytes: Buffer; mime: string | null } | null {
  const parsed = McpResultSchema.safeParse(raw ?? {});
  if (!parsed.success || !parsed.data.content) return null;
  for (const block of parsed.data.content) {
    // Inline binary block (image/audio): base64 in `data`.
    if (typeof block.data === "string") {
      const bytes = decodeBase64(block.data);
      if (bytes?.length) return { bytes, mime: block.mimeType ?? null };
    }
    // Embedded resource: bytes in `resource.blob` (base64) or `resource.text`.
    const res = block.resource;
    if (res) {
      if (typeof res.blob === "string") {
        const bytes = decodeBase64(res.blob);
        if (bytes?.length) return { bytes, mime: res.mimeType ?? null };
      }
      if (typeof res.text === "string" && res.text !== "") {
        return { bytes: Buffer.from(res.text, "utf8"), mime: res.mimeType ?? null };
      }
    }
    // Plain text block.
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
      return { bytes: Buffer.from(block.text, "utf8"), mime: block.mimeType ?? null };
    }
  }
  return null;
}

const AskStatusSchema = z.enum([
  "success", "upload_failed", "system_trigger_failed",
  "change_model_failed", "sent_message_failed",
]);

/** A partial MCP failure can still have created a bot. Preserve its handle so
 * callers can continue it, rather than blindly retrying creation.
 */
export class AskSubmissionError extends McpError {
  constructor(
    readonly status: Exclude<z.infer<typeof AskStatusSchema>, "success">,
    readonly ask: AskResult,
  ) {
    super(`${TOOL_ASK} failed: ${status}`, "tool");
    this.name = "AskSubmissionError";
  }
}

const AskArgsSchema = z.object({
  query: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  room_name: z.string().min(1).optional(),
  project_name: z.string().min(3).optional(),
  agent_response: z.enum(["auto", "force_respond", "force_skip"]).optional(),
  system_instruction: z.string().min(1).optional(),
  files: PromptQlFilesSchema.optional(),
}).strict();
const AskResponseSchema = z.object({
  status: AskStatusSchema.optional(),
  thread_id: z.string().min(1),
  thread_event_id: z.string().min(1).nullish(),
});

export type BotResponse =
  | { status: "completed"; message: string; artifacts: ResponseArtifact[] }
  | { status: "declined_approval"; message: string }
  | { status: "failed"; message: string };

export const PostingIdentitySchema = z.union([
  z.object({ role: z.literal("client") }).strict(),
  z.object({ role: z.enum(["shopper", "pa"]), shopperId: z.string().min(1) }).strict(),
]);
export type PostingIdentity = z.infer<typeof PostingIdentitySchema>;
// String callers are the shopper identity, including the discovery CLI.
export type IdentityInput = PostingIdentity | string;

function postingIdentity(input: IdentityInput): PostingIdentity {
  return PostingIdentitySchema.parse(typeof input === "string"
    ? { role: "shopper", shopperId: input } : input);
}

export interface AdapterDeps {
  config: Config;
  /** Resolve a shopper's MCP-scoped token at call time. Never cached in cleartext. */
  getToken: (shopperId: string, role: "shopper" | "pa") => string | null;
  getClientToken?: () => string | null;
  /** Optional structured logger; defaults to the process root logger. */
  log?: Logger;
}

export class PromptQlAdapter {
  private readonly sessions = new Map<string, McpSession>();
  private readonly log: Logger;

  constructor(private readonly deps: AdapterDeps) {
    this.log = deps.log ?? rootLogger.child({ component: "promptql" });
  }

  private session(input: IdentityInput): McpSession {
    const identity = postingIdentity(input);
    const key = JSON.stringify(identity.role === "client" ? ["client"] : [identity.shopperId, identity.role]);
    // Check revocation at every lookup, including response polling.
    const token = identity.role === "client"
      ? this.deps.getClientToken?.()
      : this.deps.getToken(identity.shopperId, identity.role);
    if (!token) this.sessions.delete(key);
    const cached = this.sessions.get(key);
    if (token && cached) return cached;
    if (!token) {
      throw new McpError(`no active MCP credential for ${identity.role} identity`, "protocol");
    }
    const mcp = this.deps.config.mcp;
    if (!mcp.endpoint) throw new McpError("PROMPTQL MCP endpoint not configured", "protocol");
    const session = new McpSession(
      {
        endpoint: mcp.endpoint,
        authScheme: mcp.authScheme,
        protocolVersion: mcp.protocolVersion,
        timeoutMs: mcp.timeoutMs,
        maxRetries: mcp.maxRetries,
      },
      token,
    );
    this.sessions.set(key, session);
    return session;
  }

  /** Drop a shopper's cached session (after credential rotation/revoke). */
  invalidate(input: IdentityInput): void {
    const identity = postingIdentity(input);
    this.sessions.delete(JSON.stringify(identity.role === "client" ? ["client"] : [identity.shopperId, identity.role]));
  }

  /** Discovery: list the tools this shopper's session can see. */
  async listTools(shopperId: IdentityInput) {
    return this.session(shopperId).listTools();
  }

  /**
   * Start or continue a bot (thread). Pass `threadId` to continue an existing
   * conversation, omit for a new one. `roomName`, when set, routes/creates the
   * thread in that room (must satisfy the PromptQL room_name pattern).
   */
  async ask(
    shopperId: IdentityInput,
    input: {
      query: string;
      threadId?: string | null;
      roomName?: string | null;
      files?: PromptQlFileInput[];
      agentResponse?: "auto" | "force_respond" | "force_skip";
      systemInstruction?: string;
      projectName?: string;
    },
  ): Promise<AskResult> {
    // Project-scoped servers may omit project_name from their schema. Keep it
    // optional for the existing endpoint; configure it for servers requiring it.
    const args = AskArgsSchema.parse({
      query: input.query,
      ...(input.threadId ? { thread_id: input.threadId } : {}),
      ...(input.roomName ? { room_name: input.roomName } : {}),
      ...(input.files?.length ? { files: input.files } : {}),
      ...(input.agentResponse !== undefined ? { agent_response: input.agentResponse } : {}),
      ...(input.systemInstruction !== undefined ? { system_instruction: input.systemInstruction } : {}),
      ...((input.projectName ?? this.deps.config.mcp.projectName) !== undefined
        ? { project_name: input.projectName ?? this.deps.config.mcp.projectName } : {}),
    });

    const result = await this.session(shopperId).callTool(TOOL_ASK, args);
    const parsed = AskResponseSchema.safeParse(result.structured);
    if (!parsed.success) {
      // Never include untrusted response content in a loggable error.
      throw new McpError(`${TOOL_ASK} returned an invalid bot handle`, "protocol");
    }
    const sc = parsed.data;
    const ask = { threadId: sc.thread_id, threadEventId: sc.thread_event_id ?? null };
    if (sc.status && sc.status !== "success") {
      // Error details may contain file content or PII. Expose only the status
      // and handle; do not log the server's untrusted error_message.
      throw new AskSubmissionError(sc.status, ask);
    }
    return ask;
  }

  /**
   * Blocking wait for the bot's response. Re-calls on `analyzing` (still running
   * or the long-poll timed out) until the deadline. On `waiting_approval`,
   * auto-declines every pending approval and returns a declined_approval result.
   */
  async waitForResponse(
    shopperId: IdentityInput,
    ask: AskResult,
    deadlineMs: number,
  ): Promise<BotResponse> {
    const waitArgs: Record<string, unknown> = { thread_id: ask.threadId };
    if (ask.threadEventId) waitArgs.thread_event_id = ask.threadEventId;

    while (Date.now() < deadlineMs) {
      const session = this.session(shopperId);
      const result = await session.callTool(TOOL_WAIT, waitArgs);
      const sc = (result.structured ?? {}) as {
        status?: string;
        message?: string;
        approvals?: Array<{ approval_id?: string; message?: string; description?: string }>;
        artifacts?: unknown;
      };
      const status = sc.status ?? "";
      const message = sc.message ?? result.text ?? "";

      if (status === "completed" || status === "success") {
        return { status: "completed", message, artifacts: parseResponseArtifacts(sc.artifacts) };
      }
      if (status === "waiting_approval") {
        await this.declineAll(session, sc.approvals ?? []);
        return {
          status: "declined_approval",
          message:
            "This request needs approval for a sensitive action. It was not auto-approved — please review it in the workspace.",
        };
      }
      if (status === "failed" || status === "error" || status === "cancelled") {
        return { status: "failed", message: message || `PromptQL run ${status}` };
      }
      // analyzing / running / anything else → keep waiting; the tool itself
      // long-polls, so we loop immediately (no extra sleep needed).
    }
    return { status: "failed", message: "PromptQL did not respond before the deadline." };
  }

  /**
   * Resolve the artifacts a completed response referenced inline, using the
   * response's own `artifacts[]` (verified live to carry the exact inline
   * `identifier` plus an `artifact_reference` with the real UUID + zero-based
   * integer version). For each inline `<artifact identifier="..."/>` tag we match
   * the response artifact by identifier and download its content directly — no
   * metadata-list call, no slug guessing.
   *
   * Returns one outcome per reference, IN THE REFERENCED ORDER: either sendable
   * bytes or a reason (too_large / unavailable). Resolution never throws for a
   * single artifact — one bad artifact cannot fail the reply.
   *
   * `maxBytes` caps each artifact's decoded size; anything larger is `too_large`.
   * Bytes are transient — the caller sends them and must not persist them.
   */
  async resolveArtifacts(
    shopperId: IdentityInput,
    responseArtifacts: ResponseArtifact[],
    refs: ArtifactRef[],
    maxBytes: number,
  ): Promise<ArtifactOutcome[]> {
    if (refs.length === 0) return [];
    const session = this.session(shopperId);
    // Exact identifier match — both the inline tag and the response artifact use
    // the same identifier string. Last write wins is irrelevant (identifiers are
    // unique per response); index for O(1) lookup preserving reference order.
    const byIdentifier = new Map<string, ResponseArtifact>();
    for (const a of responseArtifacts) byIdentifier.set(a.identifier, a);

    const outcomes: ArtifactOutcome[] = [];
    for (const ref of refs) {
      try {
        const art = byIdentifier.get(ref.identifier);
        if (!art) {
          // The tag referenced an artifact the response did not list — we have no
          // real id to download. Fail cleanly rather than guess.
          this.log.warn("artifact unresolved (not in response artifacts)", {
            identifier: maskArtifact(ref.identifier),
          });
          outcomes.push({ ok: false, identifier: ref.identifier, reason: "unavailable" });
          continue;
        }
        // download_promptql_artifact is the content tool. Version is a zero-based
        // integer; send it as-is (0 is valid and must not be dropped).
        const args: Record<string, unknown> = { artifact_id: art.artifact_reference.artifact_id };
        if (typeof art.artifact_reference.version === "number") {
          args.version = art.artifact_reference.version;
        }
        const result = await session.callTool(TOOL_DOWNLOAD_ARTIFACT, args);
        const decoded = this.decodeArtifact(ref, art, result.raw, maxBytes);
        if ("artifact" in decoded) {
          outcomes.push({ ok: true, artifact: decoded.artifact });
        } else {
          this.log.warn("artifact skipped", { identifier: maskArtifact(ref.identifier), reason: decoded.reason });
          outcomes.push({ ok: false, identifier: ref.identifier, reason: decoded.reason });
        }
      } catch (err) {
        // Never let one artifact fail the whole reply. The server's error body
        // may carry artifact content/PII, so log only the (non-sensitive) id.
        this.log.warn("artifact fetch failed", { identifier: maskArtifact(ref.identifier), err });
        outcomes.push({ ok: false, identifier: ref.identifier, reason: "unavailable" });
      }
    }
    return outcomes;
  }

  /** Normalize a downloaded artifact into WhatsApp-sendable bytes, or a failure
   *  reason: `too_large` past the cap, `unavailable` when empty or unrecoverable.
   *  `raw` is the download_promptql_artifact MCP result (typed content blocks);
   *  `meta` supplies title/type from the metadata listing. */
  private decodeArtifact(
    ref: ArtifactRef,
    art: ResponseArtifact,
    raw: unknown,
    maxBytes: number,
  ): { artifact: ResolvedArtifact } | { reason: ArtifactFailureReason } {
    const type = ref.type ?? art.artifact_type ?? null;
    const title = art.title ?? ref.identifier;

    // Pull raw bytes out of the MCP content blocks — never the JSON envelope.
    const extracted = bytesFromMcpResult(raw);
    if (!extracted || extracted.bytes.length === 0) return { reason: "unavailable" };
    const bytes = extracted.bytes;
    if (bytes.length > maxBytes) {
      this.log.warn("artifact exceeds size cap", {
        identifier: maskArtifact(ref.identifier), sizeBytes: bytes.length, maxBytes,
      });
      return { reason: "too_large" };
    }
    const resolvedMime = extracted.mime ?? mimeForType(type) ?? "application/octet-stream";
    return {
      artifact: {
        identifier: ref.identifier,
        title,
        fileName: artifactFileName(ref.identifier, type, resolvedMime),
        mimeType: resolvedMime,
        bytes,
      },
    };
  }

  /** Auto-decline every pending approval (gateway policy). */
  private async declineAll(
    session: McpSession,
    approvals: Array<{ approval_id?: string }>,
  ): Promise<void> {
    for (const a of approvals) {
      if (!a.approval_id) continue;
      try {
        await session.callTool(TOOL_RESPOND_APPROVAL, {
          approval_id: a.approval_id,
          decision: "decline",
        });
      } catch (err) {
        this.log.warn("failed to decline approval", { approvalId: a.approval_id, err });
      }
    }
  }
}

// Artifact identifiers can echo user content, so mask them in logs like a jid.
function maskArtifact(identifier: string): string {
  if (identifier.length <= 6) return "***";
  return `${identifier.slice(0, 3)}***${identifier.slice(-2)}`;
}

// Map a PromptQL artifact type to a sensible document MIME. Unknown types get a
// text default (most non-binary artifacts are text/tabular/JSON).
const TYPE_MIME: Record<string, string> = {
  text: "text/plain",
  markdown: "text/markdown",
  md: "text/markdown",
  table: "text/csv",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
};

function mimeForType(type: string | null): string | undefined {
  if (!type) return undefined;
  return TYPE_MIME[type.toLowerCase()];
}

const MIME_EXT: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "text/html": ".html",
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/pdf": ".pdf",
};

/** Build a safe WhatsApp document name from the artifact identifier + MIME.
 *  Mirrors mediaFileName: strip anything that isn't filename-safe. */
function artifactFileName(identifier: string, type: string | null, mime: string): string {
  const safeId = identifier.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "artifact";
  const base = safeId.startsWith("artifact") ? safeId : `artifact-${safeId}`;
  const ext = MIME_EXT[mime.split(";")[0]!.trim()] ?? (type ? `.${type.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 8) : "");
  return base.endsWith(ext) || ext === "." ? base : `${base}${ext}`;
}
