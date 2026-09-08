# AGENTS.md

Agent notes for **sept-wa-gateway** — a WhatsApp gateway that links a number
through Baileys, resolves each chat to a registered shopper, and routes messages
to a PromptQL project over the PromptQL **MCP** server. It runs in the cloud as a
container; a local run (personal number) is just for testing. The connection is
managed over the HTTP API, not baked in at build time.

For the user-facing overview, architecture, setup, API reference, and open
decisions, see **[README.md](README.md)**. This file is the short list of things
an agent must NOT get wrong.

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

## Group trigger, mirror and membership rules

- Before the first registered shopper tag, groups are captured in
  `whatsapp_message_store` only. **No MCP call and no backfill.**
- A tag must mention the linked account's PN JID or LID in the current message's
  `contextInfo.mentionedJid`. Strip device suffixes, but keep JID domains.
  Quotes alone do not trigger. **`fromMe` never triggers.**
- A registered, enabled shopper with an active credential triggers via
  `force_respond`, under their own token. **Group mappings never override the
  sender.** Several shoppers intentionally share one bot per group.
- After activation, other messages use `force_skip` under the **last tagger's**
  token (`chat_bot.shopper_id`). This includes unregistered members, their tags,
  and manual messages from the linked phone, but excludes gateway-sent replies.
- Every group post has a sender prefix. `senderLabel()` owns the format:
  registered name plus full E.164 when available; otherwise E.164, or an explicit
  opaque WhatsApp JID if no phone is known. Never invent a phone from LID digits.
  Logs still mask all PII. Strip `@digits` from group text.
- Group media uses a type marker plus caption, not `files`. DM file delivery is
  unchanged.
- Serialize submissions per `(connection_id, chat_jid)` through MCP acceptance,
  not the response wait. Relays use the fenced outbound idempotency log.
  Capture-only duplicates must never become backfill. There is no catch-up job.
- Baileys 7.0.0-rc14 membership events contain **participant objects**, not
  strings. Validate payloads with Zod; match `id`, `lid`, and `phoneNumber`
  against `sock.user.id` and `sock.user.lid`.
- Self-remove and self-add both set `chat_bot.relay_paused_at` for existing
  rows. Self-add also covers removals missed during downtime. Membership alone
  never creates a bot or calls MCP. Removal deletes cached group metadata.
- While paused, capture only. The next registered tag continues the same
  `thread_id` and resumes mirroring. A membership change during an in-flight
  tag must not be erased when that call completes.
- Paused outbound replies are skipped and logged as `chat_left`, including
  replies waiting in the anti-ban queue. An already-sending reply may fail
  normally. **No membership marker, DM fallback, or rejoin policy switch.**
- Generate and persist gateway outbound IDs before Baileys can echo them.
  Keep these IDs even if the send result is uncertain.
- Room placement is deferred: a new group bot still uses the first tagger's
  caller-owned room. All participating shopper service accounts must be able
  to access that bot. Cross-shopper MCP access remains a rollout check.

## Security invariants

- **Every `/api/v1/*` endpoint requires the admin token** (`GATEWAY_ADMIN_TOKEN`,
  constant-time compare). The tunnel URL is never a security boundary.
- The admin credential is separate from PromptQL MCP credentials and from
  per-shopper tokens.
- **Secrets are encrypted at rest** (Baileys session state, per-shopper MCP
  tokens) under `DATA_ENCRYPTION_KEY`. **Never log or return a raw secret** —
  the API returns only a `tokenFingerprint`. `.env` is git-ignored.
- **DM identity:** an internal chat mapping wins; otherwise resolve the sender's
  WhatsApp phone to a registered, enabled shopper with an active credential.
  **Group identity:** only the sender's own registration can authorize a tag.
  WhatsApp-provided sender phones are the accepted pilot identity source.
  Unregistered senders never trigger work; their messages may be group context
  after activation. There is deliberately no mappings API.
- `connection_id` is a routing key, not an authorization boundary.

## Connection management & deploy

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

- DM media is downloaded promptly because WhatsApp CDN URLs expire, held only in
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

## Open decisions (current choices)

Kept visible per the handoff. Current choices are marked.

| Decision | Current choice |
|---|---|
| DM vs group mapping model | DM mapping override or sender fallback; groups always trigger as the sender. |
| Mirror every message vs explicit invocation | DMs respond as before. Groups require a registered tag to activate, then mirror with `force_skip`; only registered tags respond. |
| One service account vs shopper + assistant identities | **One** MCP-scoped service account per shopper. Schema (`shopper_credential.label`) keeps room for a second identity. |
| Response path: webhook / poll / other | Responding asks wait for a reply. Context-only `force_skip` posts never wait. |
| Bot (thread) continuity | **Persist per chat** in `chat_bot` — follow-up messages continue the same bot. |
| Approvals (`waiting_approval`) | **Auto-decline + notify** the shopper to approve in the console. |
| Thread room scoping | **Caller-owned per-shopper room** — `roomName` is set at registration and sent verbatim. The gateway does not derive or own room semantics. |
| Shopper deletion vs disabling | **Disable only** for now (status flag). Hard delete not implemented. |
| Local tunnel + auth | **ngrok** (or equivalent) + admin token. Tunnel URL is not a boundary. |
| Local data + secret retention / backup | SQLite at `GATEWAY_DB_PATH`; message retention `WHATSAPP_MESSAGE_RETENTION_DAYS` (purge job not yet wired). Secrets encrypted at rest under `DATA_ENCRYPTION_KEY`. |
