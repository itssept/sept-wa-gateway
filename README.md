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
| WhatsApp | `src/whatsapp/` | Encrypted Baileys auth, socket lifecycle, anti-ban queue, media download and object storage. |
| Security | `src/security/` | Admin auth (constant-time). |
| PromptQL | `src/promptql/` | MCP client (JSON-RPC 2.0 / Streamable HTTP), adapter, discovery diagnostic. |
| Routing | `src/routing/` | Resolver, inbound router, outbound dispatcher. |
| HTTP | `src/http/` | Management API + server entrypoint. |

## How it works

- **Shoppers must be registered first.** Registration stores a name, canonical
  phone (E.164), a generated shopper id, a caller-owned PromptQL `roomName`, and
  one MCP-scoped service-account token (encrypted at rest, never returned after
  creation).
- **Routing keys on the sender.** The gateway auto-resolves by the message
  sender's phone to a registered, enabled shopper. Unregistered senders are
  dropped. There is no mappings API — callers work in shoppers and phone
  numbers, not WhatsApp jids.
- **Each shopper gets its own MCP session,** so PromptQL attributes the work to
  the right service account. Follow-up messages continue the same bot (per-chat
  continuity in `chat_bot`).
- **Media is downloaded transiently and attached to PromptQL.** WhatsApp CDN
  URLs expire, so supported image, video, audio, document, and sticker messages
  are downloaded into bounded memory and relayed through `ask_promptql.files`.
  The bytes are discarded after the MCP call accepts or exhausts its retries;
  they are never persisted by the gateway. A process crash loses any in-flight
  media. The raw-media limit is 7 MiB so base64 plus query metadata stays below
  the default 10 MiB MCP request cap.
- **Every `/api/v1/*` endpoint requires the admin token** (`GATEWAY_ADMIN_TOKEN`,
  constant-time compare). Secrets are encrypted at rest and never logged or
  returned after creation. Rejected senders are silently dropped with an audit
  line — no unsolicited reply.

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

Link a number over the API — this is the **only** way to set the number:

```bash
ADMIN=<GATEWAY_ADMIN_TOKEN>
BASE=http://localhost:8790

# 1. Start pairing.
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/connection/link \
  -d '{"phone":"+14155551212","deviceLabel":"sept-gateway"}'

# 2. Poll for the pairing code, then enter it on the phone:
#    Linked Devices → Link a Device → Link with phone number instead.
curl -H "Authorization: Bearer $ADMIN" $BASE/api/v1/connection
# ...repeat until "status":"linked".
```

The linked session is persisted (encrypted) in SQLite, so the gateway resumes it
on the next boot without re-pairing. Expose the API through a tunnel for local
testing (`ngrok http 8790`); the tunnel URL is not a security boundary — the
admin token gates every call.

### Register a shopper

```bash
# roomName is the caller-owned PromptQL room_name for this shopper (mandatory).
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","roomName":"rakesh-room","mcpToken":"<mcp-scoped-token>"}'
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
