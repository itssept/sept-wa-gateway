# sept-wa-gateway

WhatsApp gateway for SEPT. It links a WhatsApp number through Baileys, resolves
each inbound chat to a registered **shopper**, and routes the message to a
**PromptQL** project over the PromptQL **MCP** server. The PromptQL response is
delivered back to the originating WhatsApp chat.

The gateway is a **transport and routing layer only**. Business catalogs,
inventory, agent instructions, claims, and execution live in PromptQL, not here.

It runs in the cloud as a container. You can also run it locally (linking a
personal number) for testing — the only difference is where it runs and which
number you link. The connection is managed over the HTTP API, so a PromptQL
project can drive it.

> Transport is Baileys, an unofficial WhatsApp Web client. It carries ToS and
> account-ban risk. The send path enforces behavioral anti-ban controls; do not
> bypass them. See **[AGENTS.md](AGENTS.md)** for the hard rules.

## Architecture

```
WhatsApp  ──►  Baileys socket ──► InboundRouter ──► PromptQlAdapter ──► MCP endpoint
(number)       (src/whatsapp)      (resolve+reject)   (ask_promptql)     (PromptQL)
                                        │                                    │
                                   sender → shopper                          │
                                   chat_bot → thread_id            get_latest_promptql_
                                        │                          thread_response (block)
                                        │                                    ▼
WhatsApp  ◄──  AntiBan queue  ◄── OutboundDispatcher ◄──────────────  bot message
```

| Layer | Path | Responsibility |
|---|---|---|
| Config | `src/config.ts` | Zod-validated env. MCP URL / path / auth scheme configurable. |
| Crypto | `src/crypto.ts` | AES-256-GCM at rest, constant-time compare, one-way hash. |
| Storage | `src/storage/` | SQLite migrations + repositories. |
| WhatsApp | `src/whatsapp/` | Encrypted Baileys auth, socket lifecycle, anti-ban queue, transient media download. |
| Security | `src/security/` | Admin auth (constant-time). |
| PromptQL | `src/promptql/` | MCP client (JSON-RPC 2.0 / Streamable HTTP), adapter, discovery diagnostic. |
| Routing | `src/routing/` | Resolver, inbound router, outbound dispatcher. |
| HTTP | `src/http/` | Management API + server entrypoint. |

## How it works

- Call `/api/v1/setup` with the gateway's Client service-account token and common
  public room. Then link the WhatsApp number and complete pairing. Finally,
  register each shopper with their public room and two distinct MCP tokens:
  shopper and PA (personal assistant).
- One bot is kept per WhatsApp chat. Posting identity is chosen per message.
  MCP sessions are isolated by shopper and role, plus a separate Client session.
  Registration, setup, rotation and revocation invalidate the affected sessions.
- Shopper text is sent unchanged, without a prefix. Client posts use
  `[Client] <push name>, <E.164>` on one line, then the text or caption. Missing
  names are omitted; missing phones use the opaque LID or `no phone`.
- Image, video, audio, document and sticker files are downloaded transiently
  in DMs and groups, attached through `ask_promptql.files`, then released.
  Original document names and voice-note labels are preserved. Contact cards
  and locations get labels only, not converted attachments. Failed downloads
  still relay the caption or media kind. Bytes are never persisted.
- The raw-media limit is 7 MiB; the complete MCP request is capped at 10 MiB.
  A partial MCP failure preserves any returned bot handle. Its text is retained
  encrypted and retried without media or a bot run on the next message.
- When a completed response references artifacts inline
  (`<artifact identifier="..."/>`), those artifacts are fetched
  (`list_promptql_thread_artifact_metadata` → `get_promptql_artifact`, matched by
  `artifact_id`/identifier, never the display title) and delivered **together
  with the text**: the reply text becomes the caption on the first document, and
  any further artifacts follow as their own documents. The inline tags are
  stripped from the text. Each artifact is capped at `PROMPTQL_MAX_ARTIFACT_BYTES`
  (16 MiB). An oversized or unfetchable artifact is skipped and audited, and a
  short note is appended to the reply in brackets, e.g.
  `(Attachment too large to send)` or `(Attachment couldn't be retrieved)`. The
  text reply is always delivered regardless.
- Every `/api/v1/*` endpoint requires `GATEWAY_ADMIN_TOKEN`. Missing Client
  setup drops Client traffic with an audit/log, without a WhatsApp reply.

### Routing

A qualifying group contains the linked number and at least one enabled,
registered shopper. Mirroring starts with the first message, without a tag.

| Message | Posting identity | Bot response |
|---|---|---|
| Shopper DM | Shopper | Always; reply to DM |
| Shopper in qualifying group | That shopper | Only when tagging the linked number |
| Client in qualifying group | Client | Relay only |
| Client tag in qualifying group | Client relay, then owner's PA prompt | PA reply to group |
| Client DM or any message in unqualified group | Client, common room | Never |
| Linked phone's manual message | Fixed owner's shopper identity, or Client for common-room chats | Never |
| Gateway's own reply | Not posted again | None |

A qualifying group's owner is the shopper who added the linked number, or the
earliest registered enabled shopper in the group if the inviter is not one.
Owner and room are fixed when the bot is created. Another shopper's tag or
removal/re-add never transfers ownership. Shopper and common rooms must be
public so all three identities can access the same bot.

If an unknown DM sender is registered as an enabled shopper, or a previously
unqualified group gains an enabled registered shopper, the next eligible
message starts a **new bot in the shopper's room**. Each chat switches
independently. The old common-room bot is not moved or deleted, and already
relayed messages are not copied. Pending pre-registration text is recovered
on the old bot before switching; failed recovery blocks the switch. History
can also initiate this transition, without triggering a response.
Already shopper-owned bots keep their original owner and room.

Client tags first relay with `force_skip`, then the owner's PA posts:
`Please respond to the client message above on behalf of [shopper name].`
This second post uses `force_respond`; its reply goes through the outbound
queue with `pa_reply` pacing. Shopper replies retain default pacing.

Removal stops relay and suppresses pending replies with `chat_left`. Re-add
resumes the same bot and owner, without needing another tag. Manual messages
never trigger. Only current-message mentions of the linked PN JID or LID count,
not quoted mentions.

Submissions are FIFO through MCP acceptance, not through the response wait.
`force_skip` never creates a response workflow or WhatsApp reply. Local
deduplication is durable, but a crash or ambiguous remote acceptance can still
leave a gap or duplicate. There is no remote exactly-once guarantee.

### Group history

`WHATSAPP_CAPTURE_GROUP_HISTORY=true` captures history WhatsApp shares on
join/re-add. `WHATSAPP_HISTORY_JOIN_WAIT_MS` defaults to 5000 (integer 0 to
60000). Live messages for that group wait for history completion
(`progress=100` or an unchunked event) or the timeout, without blocking history
capture. Set 0 to disable the join wait.

History chunks received during the wait are sorted together, oldest first.
Client posts `Replaying N messages from group history, oldest first`, each row
is relayed using the normal identity, envelope and file rules with `force_skip`,
then Client posts `End of history`. No rows means no bot or bracket posts.
Only accepted rows are marked relayed. Failed rows remain available for a
later batch; there is no automatic retry loop.

History arriving after the join wait is replayed late, before subsequent live
traffic. A small number of live messages can therefore precede it. Ordering
across chunks that arrive after the timeout cannot be globally guaranteed.
Replay never triggers a bot run or sends a WhatsApp reply.

### Rollout checks

Set `PROMPTQL_PROJECT_NAME` if the deployed MCP schema requires it. Before
rollout, confirm `agent_response` and file support using live shopper, PA and
Client tokens, and confirm that all identities can post into the public rooms
and each other's bots. Also confirm the artifact tools
(`list_promptql_thread_artifact_metadata`, `get_promptql_artifact`) and their
exact argument names with `bun run mcp:discover`; the adapter assumes
`thread_id` / `artifact_id` / `version`. Tests mock these boundaries; they are
not a live WhatsApp or production-token validation.

The gateway emits **structured JSON logs** (one object per line) to **stderr**
for cloud log aggregation. PII (phone numbers, jids, secrets) is masked, and
message bodies are never logged — only their length. Level is set by `LOG_LEVEL`
(default `info`).

## Getting started (local test)

```bash
bun install
cp .env.example .env      # then fill in the values below

# Generate secrets:
openssl rand -hex 32      # GATEWAY_ADMIN_TOKEN
openssl rand -hex 32      # DATA_ENCRYPTION_KEY

bun run start
```

Follow this order: **setup, link, then register shoppers**. Linking and
registration return `409` until setup is complete. The API is the only way to
set the linked number:

```bash
ADMIN=<GATEWAY_ADMIN_TOKEN>
BASE=http://localhost:8790

# 1. Configure the gateway Client SA and common public room.
#    Optional: add "clientServiceAccountId":"<id>" (non-secret, shown in /status).
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/setup \
  -d '{"clientMcpToken":"<client-token>","commonRoomName":"sept-common"}'

# 2. Start pairing.
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/connection/link \
  -d '{"phone":"+14155551212","deviceLabel":"sept-gateway"}'

# Poll for the pairing code, then enter it on the phone:
#    Linked Devices → Link a Device → Link with phone number instead.
curl -H "Authorization: Bearer $ADMIN" $BASE/api/v1/connection
# ...repeat until "status":"linked".
```

The linked session is persisted (encrypted) in SQLite, so the gateway resumes it
on the next boot without re-pairing. Expose the API through a tunnel for local
testing (`ngrok http 8790`); the tunnel URL is not a security boundary — the
admin token gates every call.

### 3. Register a shopper

```bash
# Each shopper has a public room and separate shopper and PA tokens.
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","roomName":"rakesh-room","mcpToken":"<shopper-token>","paMcpToken":"<pa-token>"}'
```

That is all a shopper needs. Their WhatsApp messages to the linked number then
auto-route by phone — no chat mapping step.

## Deployment (cloud)

A multi-arch image (amd64 + arm64) is published to **GHCR** on every version
tag. How you run it — plain `docker run`, Compose, Kubernetes, a PaaS — is up to
the deployer. The image only needs the right env, a durable `/data` volume, and
port `8790`.

```bash
docker run -d --name sept-wa-gateway -p 8790:8790 \
  -v sept-wa-data:/data \
  -e DATA_ENCRYPTION_KEY=<64 hex> \
  -e GATEWAY_ADMIN_TOKEN=<64 hex> \
  -e 'PROMPTQL_MCP_URL=https://data.prompt.ql.app/promptql/mcp-server/mcp?project-name=<project>' \
  ghcr.io/hasura/sept-wa-gateway:latest
```

Two things must be right or the deploy breaks:

- **Durable volume at `/data`** holds the SQLite DB (encrypted session and
  secrets). Back it up; losing it forces a re-link and shopper re-registration.
- **`DATA_ENCRYPTION_KEY` must stay stable** across restarts, or that persisted
  state becomes unreadable. Provision it out of band.

A single WhatsApp session must have exactly one owner — do not run two replicas
on the same number. After deploy, link the number via
`POST /api/v1/connection/link` (see above).

Full detail — the image release workflow, every env var, and the deployment
checklist — is in **[docs/deployment.md](docs/deployment.md)**.

## Testing

```bash
bun test        # unit + boundary tests
bun run typecheck
```

## More detail

- **[docs/deployment.md](docs/deployment.md)** — image release workflow (GHCR),
  full env-var reference, and the deployment checklist.
- **[docs/admin-api.md](docs/admin-api.md)** — full Management API reference:
  endpoints, request/response shapes, error codes.
- **[AGENTS.md](AGENTS.md)** — the hard rules (anti-ban contract, PromptQL MCP
  wire contract, open decisions) an agent must not get wrong.

Baileys/session/anti-ban patterns are adapted from `hasura/whatsapp-gateway`
(studied as behavior reference, not a dependency). This repo is a fresh
implementation with a deliberately small scope: one connection, cloud-deployable,
API-managed.
