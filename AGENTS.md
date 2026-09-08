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
- A client tag in a qualifying group produces two posts: Client relay, then
  fixed owner's PA prompt with `force_respond`. `paPrompt()` owns the exact
  wording. Reply through the dispatcher with `pacingProfile: "pa_reply"`;
  shopper replies use default pacing.
- Owner is the shopper who added the linked number, otherwise the earliest
  registered enabled shopper in the group. Fix owner and public room when
  creating the bot. Never transfer on a tag or removal/re-add.
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
  constant-time compare). The tunnel URL is never a security boundary.
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
