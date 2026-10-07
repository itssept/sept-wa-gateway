# AGENTS.md

Bot notes for **sept-wa-gateway** — a WhatsApp gateway that links a number
through Baileys, resolves each chat to a registered shopper, and routes messages
to a PromptQL project over the PromptQL **MCP** server. It runs in the cloud as a
container; a local run (personal number) is just for testing. The connection is
managed over the HTTP API, not baked in at build time.

For the user-facing overview, architecture, setup, API reference, and open
decisions, see **[README.md](README.md)**. This file is the short list of things
a bot must NOT get wrong.

## Runtime & commands

- **Bun + TypeScript, ESM.** Not Node. Use `bun:sqlite`, `bun test`.
- `bun run typecheck` — must stay clean.
- `bun test` — must stay green before you hand work back.
- `bun run start` / `bun run dev` — boot the gateway.
- `bun run mcp:discover` — inspect the live PromptQL MCP tool list (uses
  `PROMPTQL_MCP_TEST_PAT`). Re-run after any PromptQL release.

## The WhatsApp ban-risk contract (READ BEFORE TOUCHING THE SEND PATH)

A linked WhatsApp session can be **banned** by bad behavior. These are hard rules:

1. **Never unsolicited first contact.** The gateway only replies inside chats
   that messaged it. Rejected senders are **silently dropped + audited** — never
   send them a WhatsApp reply.
2. **Never bypass the anti-ban queue.** Every outbound goes through
   `src/whatsapp/antiBan.ts` (per-chat serialization, per-connection token
   bucket, `composing` presence + randomized delay, warm-up). Do not call
   `sock.sendMessage` directly — use `WhatsAppConnection.sendText`.
3. **Pairing-code ONLY, no QR.** Requesting a pairing code while a QR is live
   half-finishes the handshake. Never surface the QR.
4. **Browser tuple must be a stock `Browsers.*` preset** (`Browsers.ubuntu("Chrome")`).
   WhatsApp rejects the pairing code for a non-standard tuple. Do not stuff a
   device label into the tuple.
5. **Always `fetchLatestWaWebVersion()`** at socket build — never the bundled
   Baileys default (goes stale, makes linking loop on 401/428).
6. **`loggedOut` (401) on a linked connection = STOP, never auto-relink.**
   Transient closes use capped exponential backoff only.
7. **Graceful shutdown uses `ws.close()`, never `logout()`** (logout unlinks the
   device and forces a re-pair). Persist creds, resume next boot.

## The PromptQL MCP contract

The base ask/wait flow was verified live on 2026-09-04. Group response controls
are covered by mocked boundary tests, not a live shopper-token test.

- **Endpoint** is the full `PROMPTQL_MCP_URL`, including `?project-name=...`.
  Never construct a different endpoint. `PROMPTQL_PROJECT_NAME`, when set,
  also supplies the MCP tool's `project_name` argument. It is optional for
  compatibility with the older project-scoped server. Check `listTools()` with
  a shopper token before rollout to see whether the deployed schema requires it.
- **Auth:** `Authorization: pat <token>` (scheme configurable).
- Responses use SSE. The verified server is sessionless: do not invent a
  `Mcp-Session-Id`. `notifications/initialized` returns HTTP 202.
- Responding calls use `ask_promptql`, then
  `get_latest_promptql_thread_response`. Re-poll on `analyzing`; auto-decline
  `waiting_approval` and notify the shopper. Never auto-approve.
- `force_skip` is a context-only post: **never wait for a response**, create a
  response workflow, or send a WhatsApp reply for it.
- Artifacts: only a **completed** response can carry artifacts. Relay ONLY the
  artifacts it references inline (`<artifact identifier="..."/>`), fetched via
  `list_promptql_thread_artifact_metadata` then `get_promptql_artifact`, matched
  by `artifact_id`/exact identifier — **never the display title**. Strip the tags
  from the text. Resolve artifacts BEFORE sending so text + files go out
  together: the reply text is a **short plain-text caption on the first
  document** (Markdown headers, emphasis, and fenced or inline code are
  stripped; the file holds the detail), extra artifacts follow as their own
  documents through `sendDocument` (the anti-ban queue). Text-only replies are
  plain text too, and are not shortened. The operator welcome template is kept
  whole when it is prefixed onto a caption. Record every document as a gateway echo. Bytes are transient (cap
  `PROMPTQL_MAX_ARTIFACT_BYTES`), released after each send, never persisted. Best-
  effort: a failed/oversized artifact is skipped, logged, and noted to the user
  in brackets appended to the reply (e.g. `(Attachment too large to send)`);
  it never fails the reply. The first send is the reply that satisfies the
  inbound claim — its failure marks the outbound record failed; follow-up
  document failures do not. Never scan a declined-approval notice for artifacts.
- Invoice PDF guard: a reply that presents an invoice or PDF without an
  `application/pdf` artifact must not leave as a ql.app link, an HTML chip, or
  a claim that a PDF was sent. The same rule covers lookbooks and other
  documents: attach a real `application/pdf` or send `Preparing the document.
  I will send it in this chat when it is ready.` A stored invoice PDF is not
  reused as a lookbook. HTML bytes are not a WhatsApp document, even
  when the artifact is labeled `file` or `application/pdf`. Attach a real PDF —
  a thread artifact from `list_promptql_thread_artifact_metadata` plus
  `download_promptql_artifact`, or a SEPT-branded PDF built only from invoice
  facts already in the turn — with the caption `Here is the commercial
  invoice.` If no real invoice PDF can be produced, send `Preparing the invoice. I
  will send it in this chat when it is ready.` Never ask for payment
  credentials. The PDF header is the word SEPT, never "SEPT LUXURY CONCIERGE".
  Strip Teach SEPT / teach-footer chrome from captions and body text.
  Invoice asks (including a photo plus "invoice this") also append a
  turn-scoped `generate_invoice_pdf` / `application/pdf` contract onto
  `system_instruction`. Shopper text itself is not wrapped.
- Voice notes are transcribed on the gateway before `ask_promptql`. Do not
  upload the audio file — that is what makes the agent call the approval-gated
  transcription tool, which operators cannot approve by typing in WhatsApp.
  `GATEWAY_VOICE_STT_URL` is an optional OpenAI-compatible speech endpoint.
  When no transcript is available, a voice-only shopper or PA turn is
  `force_skip` plus one honest WhatsApp line, not a responding run. The
  turn's `system_instruction` forbids external speech APIs, approval
  prompts, and claims that approvals or platform settings were changed.
- Outbound text drops sentences that claim the agent changed PromptQL
  approvals, background permissions, or platform settings. Negated lines
  ("was not auto-approved", "cannot change approval settings") and ordinary
  "for your approval" copy still send.
- Bare re-tags while a run is in flight (`@SEPT`, `?`, `pls`, no new text and
  no photo) are `force_skip` context, not a new `force_respond`. A photo
  album (10–34 images, with or without a trailing caption such as "Please
  take orders") is one ask. `WHATSAPP_MEDIA_BURST_MS` (default 45000, resets
  on each image, max 180000) is that quiet window — the 5s text debounce is
  too short while a phone uploads the album, and each flushed photo was its
  own `force_respond` (`SEPT was stopped.`). The socket must accept the next
  photo into the open buffer without waiting out an in-flight ask. Image
  bytes are staged into `files[]` (one body when they fit). Do not replace a
  failed upload with a text-only media-bridge ask; that is the `(image)` /
  `upload_failed` placeholder. A real follow-up after the album window still
  triggers at once unless `GATEWAY_IN_FLIGHT_WAIT_MS` is set. `SEPT was
  stopped.` is not a WhatsApp message. Identical `Preparing the invoice…`
  lines for one chat collapse to a single send.
- Product concept: **bot**. Keep legacy `thread_id` on the wire and in storage.
- **`src/promptql/promptqlAdapter.ts` is the only place that shapes MCP args.**
  `agent_response`, `system_instruction`, and `project_name` belong there.

## Routing, ownership and history

- Mirror qualifying groups from the first message. Qualification requires the
  linked number and an enabled registered shopper in membership metadata.
- Shopper DM: shopper SA, always `force_respond`. Qualifying group: each
  shopper's own SA, responding only to their tag of the linked number.
- Client DM/unqualified group: Client SA in the common public room, always
  `force_skip`. In qualifying groups Client posts also use `force_skip`.
  Missing Client token or common room means audit/log and drop, never crash.
- Ownerless chats (unregistered DM sender, unqualified group; `ownerId === null`
  in `destination()`) relay to the common room only when
  `RELAY_UNREGISTERED_CHATS=true`. Default false: drop and audit
  (`inbound.rejected`, reason `unregistered_chat_relay_disabled`), never crash.
  The gate never touches shopper-owned or qualifying chats, and a dropped chat
  still promotes normally on the next message once it qualifies.
- A client tag in a qualifying group produces two posts: Client relay, then
  fixed owner's PA prompt with `force_respond`. `paPrompt()` owns the exact
  wording. Reply through the dispatcher with `pacingProfile: "pa_reply"`;
  shopper replies use default pacing.
- Owner is the shopper who added the linked number, otherwise the earliest
  registered enabled shopper in the group. Fix owner and public room when
  creating the bot. Never transfer on a tag or removal/re-add.
- If an ownerless common-room chat becomes eligible for a shopper, start a NEW
  bot in that shopper's room on the next eligible live/history submission.
  Do not reparent the old bot or replay already-relayed messages. Resolve any
  pending common-bot text there before switching. Persist the new owner/room
  with a returned handle, including partial MCP failures; ordinary failures
  leave the common mapping intact. Shopper-owned bots remain fixed.
- Shopper text has no envelope or provenance prefix. Only Client posts use
  `formatClientEnvelope`. Preserve push name, opaque LID when phone is unknown,
  original document filename and voice-note `ptt`. Do not strip shopper text.
- Both DMs and groups attach supported media via `promptQlFileFromMedia`.
  Contact cards and locations are labels only. Always release media after
  submission; never persist the bytes.
- Linked-phone manual messages use fixed owner's shopper identity, or Client
  for common-room chats, with `force_skip`. Exclude gateway echoes using IDs
  recorded before sending. `fromMe` never triggers.
- Match PN/LID mentions only in current-message context, never quoted text.
  Baileys membership events contain participant objects, not strings. Validate
  with Zod. Preserve inviter, refresh metadata on membership updates, and fence
  stale events/fetches across removal/re-add.
- Removal stops relay and suppresses queued replies (`chat_left`).
  Re-add resumes the same bot without a tag. Duplicate add notifications must
  not discard buffered live messages or reset ownership.
- `WHATSAPP_CAPTURE_GROUP_HISTORY=true` enables join history.
  `WHATSAPP_HISTORY_JOIN_WAIT_MS` defaults to 5000, validated as integer 0 to
  60000. Buffer live input without media allocation until history completes
  (`progress=100` or unchunked) or the bounded wait expires. Do not block the
  input queue while waiting, since history needs that queue.
- Sort the accumulated history oldest first, bracket it with Client posts
  `Replaying N messages from group history, oldest first` and `End of history`.
  Use normal posting identity/envelope/file rules, always `force_skip`.
  Zero rows does nothing. Mark only accepted rows; failed rows remain available
  for a later batch with no automatic retry loop.
- History arriving after the join wait is replayed late, before further live
  traffic. A small number of live messages can precede it. Chunks arriving
  after timeout cannot be globally reordered against already-relayed history.
  Replay never triggers or sends WhatsApp replies.
- Serialize per-chat submissions through acceptance, not response polling.
  Keep shopper/PA/Client MCP sessions separate. Setup invalidates Client;
  registration invalidates both shopper roles; rotate/revoke only that role.
- On `AskSubmissionError`, retain its bot handle and encrypted pending text.
  Retry only text, as a nontriggering relay on the next message, never a fresh
  bot or persisted media. Local deduplication is not remote exactly-once.

## Security invariants

- **Every `/api/v1/*` endpoint requires the admin token** (`GATEWAY_ADMIN_TOKEN`,
  constant-time compare), except `GET` and `HEAD /api/v1/ephemeral-media/:token`.
  That route is the PromptQL fetch bridge for `upload_failed`: 48-hex unguessable
  token, multi-fetch within a 15-minute TTL (HEAD peeks and does not burn a
  fetch), no admin header. Never log the token or the URL. The tunnel URL is
  never a security boundary.
- The admin credential is separate from PromptQL MCP credentials and from
  per-shopper tokens.
- **Secrets are encrypted at rest** (Baileys session state, per-shopper MCP
  tokens) under `DATA_ENCRYPTION_KEY`. **Never log or return a raw secret** —
  the API returns only a `tokenFingerprint`. `.env` is git-ignored.
- Sender phone registration determines shopper identity. Unregistered or
  disabled senders are Clients. No chat mapping can authorize a different
  sender's shopper token. Never borrow another role's credential when missing.
- `connection_id` is a routing key, not an authorization boundary.

## Connection management & deploy

- Setup order: `POST /api/v1/setup`, then link and complete pairing, then
  register shoppers. Linking and registration return `409` before setup.
  Keep the setup gate on `POST /api/v1/connection/link`.

- The WhatsApp connection is managed ONLY over the API: `POST
  /api/v1/connection/link` (start pairing, wipes session), `GET
  /api/v1/connection` (status + pairing code), `POST /api/v1/connection/unlink`.
  A PromptQL project drives these. There is NO boot-time number config — the
  number is set via link and persisted in `whatsapp_connection`. On boot the
  gateway only RESUMES an already-linked session (reconnect, no pairing).
- Deploys as a container (`Dockerfile`). `/data` is a **durable volume** holding
  the SQLite DB (encrypted session + secrets). `DATA_ENCRYPTION_KEY` must be
  stable across restarts or that state is unreadable. Bind is `0.0.0.0`.
- One WhatsApp session = one owner. Never run two replicas on the same number.

## Keying & storage

- DM and group media are downloaded promptly because WhatsApp CDN URLs expire, held only in
  bounded memory while the PromptQL MCP submission is attempted, and then
  released. Never persist media to SQLite, disk, or object storage. Preserve
  the declared + streamed byte limits and attachment filename/MIME validation.
- All relational state is in **SQLite**, keyed by `connection_id`. Schema +
  append-only migrations live in `src/storage/schema.ts`, run by
  `src/storage/db.ts`. Add a new migration; never edit an applied one.
- Phone numbers are **canonicalized** to `+<6-15 digits>` (`canonicalizeE164`)
  before storage/compare.
- Per-chat bot continuity: `chat_bot` maps `(connection_id, chat_jid)` →
  `thread_id`. Outbound idempotency: `whatsapp_outbound_log` keyed on
  `(connection_id, inbound message id)` with claim-token fencing.

## Logging (PII contract — READ BEFORE ADDING A LOG LINE)

- **Use the structured logger** (`src/logger.ts`), never `console.*`. Get a
  bound child via `ctx.log.child({ component, ... })`; propagate `corrId`
  (the WhatsApp message id) through a flow.
- **Never log raw PII or secrets.** Mask at the call site with
  `maskJid` / `maskNumber` / `maskSecret`. **Never log a message body** — log
  `textLength` only. The logger's defensive redaction pass re-masks sensitive
  keys and drops content keys (`text`/`body`/`query`/…) as a backstop, but do
  not rely on it — mask at the source.
- **Errors** go in the `err` field (`log.error("...", { err })`) — it is
  serialized to `{name, message}` and skips content redaction.
- **stdout is reserved** for the operator pairing code; logs go to **stderr**.
- Keep **Baileys silent** (no logger passed to `makeWASocket`) — it can emit
  jids/metadata we do not control.

## Module map

`config.ts` (Zod env) · `crypto.ts` (AES-256-GCM, constant-time) · `util.ts`
(jid/E164 + masking) · `logger.ts` (structured JSON logs + PII redaction) ·
`storage/` (migrations + repos) · `whatsapp/`
(authState, socket, antiBan, media) · `security/` (admin auth) · `promptql/`
(mcpClient, adapter, discover) · `routing/` (resolver, inbound, outbound) ·
`http/` (adminApi, server) · `context.ts` (wiring).

## Conventions

- Use Zod at all new I/O boundaries.
- Match the surrounding style. Keep comments explaining **why**, as the existing
  files do.
- Keep MCP-specific code behind the adapter; keep Baileys code out of routing.
- Don't put business catalogs, inventory, or agent logic here — the gateway is a
  transport + routing layer. Business logic lives in PromptQL.

## Current choices

- Rooms are caller-supplied and public; access is a rollout check, not created
  by the gateway. Registration supplies separate shopper and PA tokens.
- Shopper deletion is disable-only; no hard-delete or mappings API.
- Responses use polling; `force_skip` never waits. Approvals are auto-declined.
- SQLite is durable at `GATEWAY_DB_PATH`. Retention is configured with
  `WHATSAPP_MESSAGE_RETENTION_DAYS`; the purge job is not yet wired.
