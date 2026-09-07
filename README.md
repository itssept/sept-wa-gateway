# sept-wa-gateway

WhatsApp gateway for SEPT. It links a WhatsApp number through Baileys, resolves
each inbound chat to a registered **shopper**, and routes the message to a
**PromptQL** project over the PromptQL **MCP** server. The PromptQL response is
delivered back to the originating WhatsApp chat.

**Deployment:** built to run in the cloud as a container. You can also run it
locally (linking a personal number) for testing — the only difference is where
it runs and which number you link. The connection is managed over the HTTP API
(link / status / unlink), so a PromptQL project can drive it; there is no
build-time or local-only coupling.

The gateway is a **transport and routing layer only**. Business catalogs,
inventory, agent instructions, claims, and execution live in PromptQL, not here.

> Transport is Baileys, an unofficial WhatsApp Web client. It carries ToS and
> account-ban risk. The send path enforces behavioral anti-ban controls; do not
> bypass them.

## Architecture

```
WhatsApp  ──►  Baileys socket ──► InboundRouter ──► PromptQlAdapter ──► MCP endpoint
(personal #)   (src/whatsapp)      (resolve+reject)   (ask_promptql)     (PromptQL)
                                        │                                    │
                                   chat_mapping → shopper                    │
                                   chat_bot → thread_id            get_latest_promptql_
                                        │                          thread_response (block)
                                        │                                    ▼
WhatsApp  ◄──  AntiBan queue  ◄── OutboundDispatcher ◄──────────────  bot message
```

| Layer | Path | Responsibility |
|---|---|---|
| Config | `src/config.ts` | Zod-validated env. MCP URL / path / auth scheme are all configurable. |
| Crypto | `src/crypto.ts` | AES-256-GCM at rest, constant-time compare, one-way hash. |
| Storage | `src/storage/` | SQLite migrations + repositories (shopper, mapping, credential, audit, outbound log, MCP workflow). |
| WhatsApp | `src/whatsapp/` | Encrypted Baileys auth state, socket lifecycle, anti-ban send queue. |
| Security | `src/security/` | Admin auth (constant-time). |
| PromptQL | `src/promptql/` | MCP client (JSON-RPC 2.0 / Streamable HTTP), adapter, discovery diagnostic. |
| Routing | `src/routing/` | Resolver, inbound router, outbound dispatcher. |
| HTTP | `src/http/` | Management API + server entrypoint. |

## Identity model

- A **shopper** must be registered before their WhatsApp messages are processed.
  Registration stores: name, canonical phone (E.164), a generated shopper id, a
  caller-owned PromptQL **`roomName`**, and one MCP-scoped **service-account**
  token (encrypted at rest, never returned after creation).
- The **room name is caller-owned**. The registrant supplies `roomName`; the
  gateway stores it verbatim and passes it to PromptQL when starting the
  shopper's thread. The gateway does not derive or own room semantics.
- **Routing is internal and keyed on the sender.** The gateway **auto-resolves
  by the message sender's phone** — the participant in a group, the chat in a DM
  — to a registered, enabled shopper. Senders that are not registered shoppers
  are dropped (`unregistered_sender`). There is **no mappings API**: callers work
  in shoppers and phone numbers, not WhatsApp jids/lids. An internal chat→shopper
  mapping table exists (and overrides the sender fallback when set) for pinning
  specific chats, but it is not exposed over the API.
- **Trust-model note (pilot):** auto-resolution takes shopper identity from the
  WhatsApp message (the sender's number). This is an intentional override of the
  stricter "identity never from a message" rule, accepted because WhatsApp
  verifies a DM account owns its number.
- A PromptQL service account is a non-human project identity. A WhatsApp chat is
  **not** a PromptQL user. The gateway maps WhatsApp identity → shopper → the
  shopper's MCP credential, and PromptQL attributes the work to that service
  account.
- Shopper identity is resolved from an explicit gateway mapping when one exists;
  otherwise from the message sender's phone (pilot override, see above). Either
  way, the **MCP credential** and service-account attribution come from the
  resolved shopper's stored record, never from message content.

## Security model

- Every management endpoint (`/api/v1/*`) requires the **admin token**
  (`GATEWAY_ADMIN_TOKEN`), compared in constant time. The ngrok URL is never a
  security boundary.
- The admin credential is separate from PromptQL MCP credentials and from the
  per-shopper tokens.
- Secrets are encrypted at rest (Baileys session state, per-shopper MCP tokens).
  Raw secrets are never logged or returned after creation. The API returns only
  a `tokenFingerprint` (sha256).
- Create / rotate / revoke / disable / mapping changes are recorded in
  `audit_log`.
- Senders that resolve to no enabled shopper — unregistered, unmapped, disabled,
  or credential-less — are **silently dropped** with an audit line, no WhatsApp
  reply (respects anti-ban / never unsolicited).
- `connection_id` is a routing key, not an authorization boundary.

## Observability (logging)

The gateway is not wired to an external observability stack, so it emits
**structured JSON logs** (one object per line) to **stderr**. Each line carries
`level`, `time`, `msg`, a `component`, and any structured fields. Cloud log
aggregation can ingest these directly.

```json
{"level":"info","time":"2026-09-04T16:02:18.454Z","msg":"inbound ask","component":"inbound","corrId":"3EB0...","chatJid":"***1212@s.whatsapp.net","shopperId":"shp_...","continuity":"new"}
```

- **Level** is set by `LOG_LEVEL` (`debug|info|warn|error`, default `info`).
- **Access log:** the admin API emits one `info` line per request with
  `method`, `resource`, `status`, and `durationMs`. It logs the **resource**
  (`shoppers`, `mappings`, …), never the raw path — a path can embed a `chatJid`.
- **Correlation:** each inbound flow binds a `corrId` (the WhatsApp message id)
  so the inbound ask and the outbound send line up across components.
- **PII is never logged raw.** Phone numbers, jids, and secrets are masked
  (`maskNumber`/`maskJid`/`maskSecret`), and a **message body is never logged**
  — only its length (`textLength`). The logger also runs a **defensive
  redaction pass** (`src/logger.ts`): any field whose key looks sensitive
  (`*jid`, `*phone`, `*token`, `text`/`body`/`query`, …) is re-masked or dropped
  even if a call site forgets to mask. Prefer masking at the call site; the
  redaction pass is the backstop.
- **Baileys' own logs stay silent** (they are noisy and can carry uncontrolled
  metadata). Only the gateway's own lifecycle/flow events are logged.
- The pairing code is printed to **stdout** for the operator (it is a
  short-lived linking secret, not persistent PII), separate from the log stream.

## PromptQL MCP integration

The gateway is an **MCP client**. This section reflects the **verified live
contract** (probed against the PromptQL MCP server, 2026-09-04).

> **Naming:** PromptQL's product concept is now a **bot**; the MCP wire still
> uses `thread_id` (a compatibility-first migration). We say "bot" in our
> code/docs but keep `thread_id` on the wire. A future additive `bot_id` alias
> may come; nothing to change until it ships.

**Endpoint shape** — the project is a **query param**, not a path segment:

```
https://data.prompt.ql.app/promptql/mcp-server/mcp?project-name=<project>
```

Set `PROMPTQL_PROJECT_URL` to the base (`https://host`) and `PROMPTQL_MCP_PATH`
to the full path + query (`/mcp-server/mcp?project-name=<project>`). The gateway
concatenates them.

**Transport reality:**
- Every response is **SSE** (`text/event-stream`), including `initialize`.
- The server is **sessionless** — it issues no `Mcp-Session-Id`. The client must
  not invent one (a bogus id returns HTTP 500).
- `notifications/initialized` returns **HTTP 202**.
- Auth: `Authorization: pat <token>` (scheme configurable).

**Message flow** (the verified tools):

1. `ask_promptql({ query, thread_id?, room_name? })` → `{ thread_id,
   thread_event_id }`. Omit `thread_id` to start a bot; pass it to continue.
2. `get_latest_promptql_thread_response({ thread_id, thread_event_id })` —
   **blocking long-poll**. Statuses: `completed` (send the `message`),
   `analyzing` (re-call), `waiting_approval` (see below).
3. `respond_to_promptql_approval({ approval_id, decision })` — on
   `waiting_approval` the gateway **auto-declines** and notifies the shopper that
   the action needs approval in the console. It never auto-approves a sensitive
   action for an unauthenticated WhatsApp sender.

Each shopper gets its own MCP session so PromptQL attributes work to the right
service account. New threads are opened in the shopper's caller-owned `roomName`
(set at registration); the gateway sends it verbatim and does not derive a room.
Per-chat continuity is stored in `chat_bot`
(`connection_id, chat_jid → thread_id`), so follow-up WhatsApp messages continue
the same bot (verified: it remembered context across two messages).

### Discovery diagnostic

```bash
PROMPTQL_MCP_TEST_PAT=<mcp-scoped-token> bun run mcp:discover
```

Prints the live tool names + JSON Schemas without recording the token. Use it to
confirm the contract still matches `src/promptql/promptqlAdapter.ts` (the one
place that shapes tool args) after any PromptQL release.

## Getting started (local test)

```bash
bun install
cp .env.example .env      # then fill in the values below

# Generate secrets:
openssl rand -hex 32      # GATEWAY_ADMIN_TOKEN
openssl rand -hex 32      # DATA_ENCRYPTION_KEY

bun run start
```

Then link a number over the API — this is the **only** way to set the number:

```bash
ADMIN=<GATEWAY_ADMIN_TOKEN>
BASE=http://localhost:8790

# 1. Start pairing for a number.
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/connection/link \
  -d '{"phone":"+14155551212","deviceLabel":"sept-gateway"}'

# 2. Poll for the pairing code, then enter it on the phone:
#    Linked Devices → Link a Device → Link with phone number instead.
curl -H "Authorization: Bearer $ADMIN" $BASE/api/v1/connection
# ...repeat until "status":"linked".
```

The linked number, its status, and the encrypted Baileys session are persisted
in SQLite (`whatsapp_connection` + `whatsapp_session_state`). On the next boot
the gateway **resumes the linked session automatically** without re-pairing —
there is no boot-time number config. (Pairing a *new* number always goes through
`POST /api/v1/connection/link`.)

Expose the API through a tunnel for local testing (`ngrok http 8790`). The
tunnel URL is not a security boundary — the admin token gates every call.

### Register a shopper

```bash
# Create/register a shopper + set its MCP credential.
# roomName is the caller-owned PromptQL room_name for this shopper (mandatory).
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","roomName":"rakesh-room","mcpToken":"<mcp-scoped-token>"}'
```

That is all the setup a shopper needs. Once registered, the shopper's own
WhatsApp messages to the linked number auto-route by their phone — no chat
mapping step, and callers never handle WhatsApp jids.

## Management API

Every `/api/v1/*` endpoint requires the admin token. A PromptQL project can call
these to manage the gateway (connection, shoppers).

Full reference — endpoints, request/response shapes, and error codes — is in
**[docs/admin-api.md](docs/admin-api.md)**.

## Deployment (cloud)

```bash
docker build -t sept-wa-gateway .
docker run -d --name sept-wa-gateway -p 8790:8790 \
  -v sept-wa-data:/data \
  -e DATA_ENCRYPTION_KEY=<64 hex> \
  -e GATEWAY_ADMIN_TOKEN=<64 hex> \
  -e PROMPTQL_PROJECT_URL=https://data.prompt.ql.app \
  -e 'PROMPTQL_MCP_PATH=/promptql/mcp-server/mcp?project-name=<project>' \
  sept-wa-gateway
```

- **Durable volume at `/data`** holds the SQLite DB — the encrypted Baileys
  session and per-shopper secrets. Back it up; losing it forces a re-link and
  re-registration.
- **`DATA_ENCRYPTION_KEY` must stay stable** across restarts/redeploys, or
  persisted session state + secrets become unreadable. Provision it out of band.
- Bind is `0.0.0.0`; put the service behind your platform ingress and expose
  only what you need. The admin token still gates `/api/v1/*`.
- After deploy, link the number via `POST /api/v1/connection/link` (see above).
  A single WhatsApp session must have exactly one owner — do not run two replicas
  on the same number.

## Testing

```bash
bun test        # unit + boundary tests
bun run typecheck
```

## Open decisions

Kept visible here per the handoff. Current choices are marked.

| Decision | Current choice |
|---|---|
| DM vs group mapping model | **Same model** — any chat jid (DM or group) maps to a shopper. |
| Mirror every message vs explicit invocation | **Mirror every** inbound message from a mapped shopper. |
| One service account vs shopper + assistant identities | **One** MCP-scoped service account per shopper. Schema (`shopper_credential.label`) keeps room for a second identity. |
| Response path: webhook / poll / other | **ask_promptql → blocking get_latest_promptql_thread_response** (verified). Re-poll on `analyzing`; auto-decline `waiting_approval`. |
| Bot (thread) continuity | **Persist per chat** in `chat_bot` — follow-up messages continue the same bot. |
| Approvals (`waiting_approval`) | **Auto-decline + notify** the shopper to approve in the console. |
| Thread room scoping | **Caller-owned per-shopper room** — `roomName` is set at registration (`POST /api/v1/shoppers`) and sent verbatim. The gateway does not derive or own room semantics. |
| Shopper deletion vs disabling | **Disable only** for now (status flag). Hard delete not implemented. |
| Local tunnel + auth | **ngrok** (or equivalent) + admin token. Tunnel URL is not a boundary. |
| Local data + secret retention / backup | SQLite at `GATEWAY_DB_PATH`; message retention `WHATSAPP_MESSAGE_RETENTION_DAYS` (purge job not yet wired). Secrets encrypted at rest under `DATA_ENCRYPTION_KEY`. |

## First-milestone status

The vertical slice is built and unit-tested, and the **PromptQL MCP half is
verified end-to-end against the live endpoint** (real `ask_promptql` →
`get_latest_promptql_thread_response` returned a completed answer, and a
follow-up on the same `thread_id` retained context).

Verified:

- [x] Exact MCP tool + schema for starting/continuing a bot (`ask_promptql`).
- [x] Response shape and blocking-wait tool (`get_latest_promptql_thread_response`).
- [x] Authorization scheme (`pat`), SSE transport, sessionless behavior.
- [x] Thread continuity across messages.

Remaining to close the milestone:

- [x] Run one **personal WhatsApp number** end-to-end through the tunnel (link
      the number, map the chat, send a message, receive the reply).
- [x] Confirm in the PromptQL console that audit attributes the work to the
      shopper's service account (needs a per-shopper service-account token, not
      the shared test PAT).
- [ ] Decide shopper vs separate assistant identity for production (schema
      already supports a second credential label).

`src/promptql/promptqlAdapter.ts` is the single place that shapes tool args;
re-run `bun run mcp:discover` after any PromptQL release to confirm it still
matches.

## Reference

Baileys/session/anti-ban patterns are adapted from `hasura/whatsapp-gateway`
(studied as behavior reference, not a dependency). This repo is a fresh
implementation with a deliberately small scope: one connection, cloud-deployable,
API-managed.
