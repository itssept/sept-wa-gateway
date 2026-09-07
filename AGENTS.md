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

## The PromptQL MCP contract (verified live — do not re-guess)

Verified against the live MCP server. Details in [README.md](README.md#promptql-mcp-integration).

- **Endpoint** = `<base>/mcp-server/mcp?project-name=<project>`. Project is a
  **query param**. The full URL is config (`PROMPTQL_PROJECT_URL` +
  `PROMPTQL_MCP_PATH`); never hardcode it.
- **Auth**: `Authorization: pat <token>` (scheme configurable).
- **Every response is SSE** (`text/event-stream`), including `initialize`. The
  server is **sessionless** — do NOT send an invented `Mcp-Session-Id` (a bogus
  one returns HTTP 500). `notifications/initialized` → HTTP 202.
- **Flow**: `ask_promptql({query, thread_id?, room_name?})` →
  `get_latest_promptql_thread_response` (blocking; re-poll on `analyzing`). On
  `waiting_approval` the gateway **auto-declines** and notifies the shopper —
  never auto-approve a sensitive action for a WhatsApp sender.
- **Naming**: product concept is a "bot"; the MCP wire still uses `thread_id`
  (compatibility migration). Say "bot" in docs/domain, keep `thread_id` on the
  wire. Do NOT invent `bot_id` until PromptQL ships it.
- **`src/promptql/promptqlAdapter.ts` is the ONLY place that shapes tool args.**
  If a PromptQL release changes a schema, fix it there.

## Security invariants

- **Every `/api/v1/*` endpoint requires the admin token** (`GATEWAY_ADMIN_TOKEN`,
  constant-time compare). The tunnel URL is never a security boundary.
- The admin credential is separate from PromptQL MCP credentials and from
  per-shopper tokens.
- **Secrets are encrypted at rest** (Baileys session state, per-shopper MCP
  tokens) under `DATA_ENCRYPTION_KEY`. **Never log or return a raw secret** —
  the API returns only a `tokenFingerprint`. `.env` is git-ignored.
- Shopper identity resolves in two steps (`src/routing/resolver.ts`): an internal
  chat->shopper mapping wins if present; otherwise the gateway **auto-resolves by
  the message SENDER's phone** (participant in a group, chat in a DM) to a
  registered, enabled shopper. **PILOT OVERRIDE:** the sender-phone fallback
  deliberately takes identity from the WhatsApp message — the opposite of the
  original "never trust the message" rule — accepted for the pilot because
  WhatsApp verifies a DM account owns its number. Unregistered senders (including
  every other participant in a group) still fall through to a silent drop
  (`unregistered_sender`). The mapping table (`MappingRepo` + `chat_mapping`) is
  an **internal mechanism only** — there is deliberately NO mappings API, because
  API users work in shoppers + phone numbers, not WhatsApp jids/lids. If a
  chat-pinning workflow is ever needed, populate mappings internally, not over
  `/api/v1`.
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

- All state is in **SQLite**, keyed by `connection_id`. Schema +
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
(authState, socket, antiBan) · `security/` (admin auth) · `promptql/`
(mcpClient, adapter, discover) · `routing/` (resolver, inbound, outbound) ·
`http/` (adminApi, server) · `context.ts` (wiring).

## Conventions

- Match the surrounding style. Keep comments explaining **why**, as the existing
  files do.
- Keep MCP-specific code behind the adapter; keep Baileys code out of routing.
- Don't put business catalogs, inventory, or agent logic here — the gateway is a
  transport + routing layer. Business logic lives in PromptQL.
