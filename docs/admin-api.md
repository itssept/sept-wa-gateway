# Admin API

The management API. A PromptQL project (or any admin caller) uses it to drive
the gateway: configure the Client service account and common room, link a
WhatsApp number, and register shoppers. Callers work in shoppers and phone numbers; WhatsApp jids/lids and chat routing are internal.

Base path: `/api/v1`. See the [README](../README.md) for the wider system
overview.

## Setup order

1. Call `POST /api/v1/setup` with the Client SA MCP token and common room name.
2. Call `POST /api/v1/connection/link` and complete WhatsApp pairing.
3. Call `POST /api/v1/shoppers` to register shoppers and their credentials.

Linking and shopper registration return `409` until gateway setup is complete.
Connection status and unlink remain available before setup, with admin auth.

## Authentication

Every `/api/v1/*` endpoint requires the **admin token**
(`GATEWAY_ADMIN_TOKEN`), passed as a bearer token and compared in constant time:

```
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

- `GET /health` is the only unauthenticated route.
- The tunnel / ingress URL is **not** a security boundary. The admin token
  gates every call.
- The admin credential is separate from PromptQL MCP credentials and from the
  per-shopper tokens.

## Conventions

- Request and response bodies are JSON. Send `Content-Type: application/json`.
- Request bodies are validated with Zod. A validation failure returns `422`
  with an `issues` array (`{ path, message }`).
- Max request body size is 1 MiB (`413` if exceeded).
- Secrets (MCP tokens, session state) are **never** returned after creation and
  never logged. The API returns only a `tokenFingerprint` (sha256).
- Gateway setup, shopper registration, credential rotation/revocation, and
  shopper status changes are recorded in `audit_log`.

### Error shape

```json
{ "error": "<message>" }
```

| Status | Meaning |
|---|---|
| 400 | Invalid JSON body. |
| 401 | Missing or wrong admin token. |
| 404 | Unknown route or resource. |
| 409 | Gateway setup is required before linking or shopper registration. |
| 413 | Request body too large. |
| 422 | Validation failed (`issues` array) or invalid E.164 phone. |
| 500 | Internal error. |
| 503 | WhatsApp connection not initialized (connection routes only). |

## Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (unauthenticated). |
| GET | `/api/v1/connection` | Connection status + current pairing code. |
| POST | `/api/v1/connection/link` | Start pairing for a number (wipes session, returns 202). |
| POST | `/api/v1/connection/unlink` | Stop + wipe session so a new number can link. |
| POST | `/api/v1/setup` | Set the gateway Client SA token and common public room. |
| POST | `/api/v1/shoppers` | Register a shopper + set shopper and PA MCP credentials. Idempotent on phone. |
| GET | `/api/v1/shoppers` | List shoppers (non-secret). |
| GET | `/api/v1/shoppers/:id` | Read one shopper + its credential info. |
| POST | `/api/v1/shoppers/:id/status` | Enable / disable. |
| POST | `/api/v1/shoppers/:id/credential/rotate` | Rotate the selected role's MCP token. |
| POST | `/api/v1/shoppers/:id/credential/revoke` | Revoke the selected role's MCP token. |
| GET | `/api/v1/status` | Setup state, common room, connection + counts. |

## Gateway setup

### POST /api/v1/setup

Set both gateway-wide inputs before linking WhatsApp or registering shoppers. Returns
`200`. Calling it again replaces both values atomically, including the Client
SA token. This endpoint does not accept other gateway configuration.

Create the Client service account with an MCP-scoped token and create the
common **public** room in PromptQL first. The gateway stores these inputs; it
does not create service accounts, mint tokens, create rooms, or verify their
permissions. The room must be accessible to the service accounts that use it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `clientMcpToken` | string (8–4096) | yes | Gateway-wide Client SA token. Encrypted under `DATA_ENCRYPTION_KEY`, never returned. |
| `commonRoomName` | string (1–80) | yes | Existing public PromptQL room for unqualified chats. Stored verbatim. |
| `clientServiceAccountId` | string (≤256) | no | Non-secret Client SA id for audit/attribution. Returned in setup and status responses. |

Blank or missing required values return `422`. A failed update leaves the old
values unchanged. Because each setup replaces all values atomically, omitting
`clientServiceAccountId` on a later setup clears any previously stored id. The
settings survive restarts in the gateway SQLite database.

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/setup \
  -d '{"clientMcpToken":"<client-mcp-scoped-token>","commonRoomName":"sept-common","clientServiceAccountId":"client-sa"}'
```

Response:

```json
{ "setupComplete": true, "commonRoomName": "sept-common", "clientServiceAccountId": "client-sa" }
```

`clientServiceAccountId` is `null` when setup completed without an id.

Setup enables Client relays and replaces the cached Client MCP session.
Missing Client setup drops Client traffic with an audit/log. It does not create
rooms; `commonRoomName` must refer to the intended public room.

## Connection

Lets an admin caller drive linking over HTTP instead of env-at-boot. After
`link`, poll `GET /api/v1/connection` for `pairingCode`, enter it on the phone
(Linked Devices → Link with phone number), then poll until `status` is
`linked`. Returns `503` if the WhatsApp connection is not initialized.

The non-secret connection view returned by these routes:

```json
{
  "connection": {
    "connectionId": "<id>",
    "number": "+14155551212",
    "status": "pending",
    "linkedAtMs": null,
    "pairingCode": "ABCD-EFGH"
  }
}
```

`status` is one of `pending`, `linked`, `logged_out`. `pairingCode` is
short-lived and only present while pairing.

### GET /api/v1/connection

Returns the current connection view (status + pairing code).

### POST /api/v1/connection/link

Gateway setup must be complete or this returns `409` without starting pairing
or changing the existing session:

```json
{ "error": "gateway setup required: POST /api/v1/setup with clientMcpToken and commonRoomName" }
```

Start pairing for a number. **Wipes the existing session.** Returns `202`; the
pairing code is issued asynchronously a moment later, so poll
`GET /api/v1/connection` for it.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `phone` | string | yes | Canonicalized to E.164 server-side. `422` if invalid. |
| `deviceLabel` | string (≤80) | no | Device label shown on the phone. |

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/connection/link \
  -d '{"phone":"+14155551212","deviceLabel":"sept-gateway"}'
```

### POST /api/v1/connection/unlink

Stop and wipe the session so a new number can link. Returns the connection view.

## Shoppers

### POST /api/v1/shoppers

Register a shopper and set (or rotate) **both** its MCP credentials, labeled
`shopper` and `pa`. Gateway setup must be complete or this returns `409` with:

```json
{ "error": "gateway setup required: POST /api/v1/setup with clientMcpToken and commonRoomName" }
```

Registration is **idempotent on phone**: an existing shopper returns `200`, a
new one returns `201`. Re-registration updates `name`, `roomName`, and both
tokens in one transaction. A disabled shopper is never implicitly re-enabled.

Create both service accounts with MCP-scoped tokens and the shopper's
**public** room in PromptQL first. The Shopper SA represents the shopper's
own messages. The PA (personal assistant) SA answers clients on their behalf.
The gateway does not mint either token or grant room access.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string (1–200) | yes | Nonblank shopper display name. |
| `phone` | string | yes | Canonicalized to E.164 server-side. `422` if invalid. |
| `roomName` | string (1–80) | yes | Existing public PromptQL room for this shopper. Stored verbatim; PromptQL validates access. |
| `mcpToken` | string (8–4096) | yes | Shopper SA MCP-scoped token. Stored encrypted, never returned. |
| `paMcpToken` | string (8–4096) | yes | PA SA MCP-scoped token. Stored encrypted, never returned. |
| `serviceAccountId` | string (≤256) | no | Non-secret Shopper SA id for audit/attribution. |
| `paServiceAccountId` | string (≤256) | no | Non-secret PA SA id for audit/attribution. |

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","roomName":"rakesh-room","mcpToken":"<shopper-mcp-token>","paMcpToken":"<pa-mcp-token>"}'
```

Response includes `{ "shopper": ..., "credential": ..., "paCredential": ... }`.
`credential.label` is `shopper`; `paCredential.label` is `pa`. Both credential
objects contain non-secret metadata and `tokenFingerprint`, never a token.

#### Upgrading existing registrations

Migration 6 creates the gateway settings table without changing existing
shoppers or credentials. It does not invent or copy a PA token. Therefore:

1. Call `/api/v1/setup` with the Client SA token and common room.
2. Re-register each existing shopper with the same phone, all required metadata,
   and both `mcpToken` and `paMcpToken`. This keeps the shopper id and status.
3. Update callers of rotate/revoke to send `role`.

Until re-registration, existing shoppers have no PA token:
`getActiveToken(shopperId, "pa")` returns `null`. The migration does not disable
them. Re-register them before rollout: a missing PA token prevents PA replies
and never falls back to the shopper token.

### GET /api/v1/shoppers

List shoppers (non-secret). Returns `{ "shoppers": [...] }`.

### GET /api/v1/shoppers/:id

Read one shopper plus its credential info. `404` if not found. Returns
`{ "shopper": ..., "credentials": [...] }`.

### POST /api/v1/shoppers/:id/status

Enable or disable a shopper. `404` if not found.

Body: `{ "status": "enabled" | "disabled" }`

### POST /api/v1/shoppers/:id/credential/rotate

Rotate the MCP token for `role: "shopper"` or `role: "pa"`. Only the selected
role's active credential is revoked and replaced. The other role is unchanged.
Invalidates the shopper's cached MCP session. `404` if the shopper is not found.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `role` | `shopper` or `pa` | yes | Identity to rotate. Missing or invalid role returns `422`. |
| `mcpToken` | string (8–4096) | yes | New MCP-scoped token. |
| `serviceAccountId` | string (≤256) | no | Non-secret service-account id. |

Example PA token rotation body:

```json
{ "role": "pa", "mcpToken": "<new-pa-mcp-token>" }
```

### POST /api/v1/shoppers/:id/credential/revoke

Revoke only the selected role's active MCP token and invalidate the shopper's
cached MCP session for that role. The other role is unchanged. `404` if the shopper is not
found. Missing or invalid role returns `422`.

Body: `{ "role": "shopper" | "pa" }`

Returns `{ "revoked": <bool> }`. It returns `false` when that role already has
no active credential. Rotation can later supply a new active token for it.

## Routing (no API)

There is **no mappings API**. How an inbound WhatsApp chat resolves to a shopper
is an internal concern of the gateway, expressed in shoppers and phone numbers,
never in WhatsApp jids/lids, which API users do not see.

Routing is implemented separately in `src/routing/`. These management
endpoints store the credentials and room names needed by routing; they do not
expose chat mappings or change group membership.

### Storage access for routing

- `ctx.credentials.getActiveToken(shopperId, "shopper" | "pa")` returns the
  active token for that role, or `null`. Omitting the role retains the existing
  `shopper` default.
- `ctx.gatewaySettings.getClientToken()` returns the Client SA token, or `null`
  before setup.
- `ctx.gatewaySettings.getCommonRoomName()` returns the common room, or `null`
  before setup.

Decrypted tokens are for immediate MCP use only. Never log, return over the
admin API, or persist the plaintext. Sessions are cached separately by shopper
and role, plus Client. Registration invalidates both shopper roles; setup
invalidates Client; rotate/revoke invalidate only the selected role.

### Routing and history configuration

- Shopper DMs always trigger. Qualifying groups mirror every message and reply
  only to shopper tags or the fixed owner's PA prompt after a Client tag.
- Client DMs and unqualified groups relay to the common public room without
  triggering. All participating identities need access to the public rooms.
- Migration 8 preserves existing bot handles and freezes their owner/room.
  It permits ownerless common-room bots, records membership/inviter, and stores
  pending text encrypted for partial MCP submission recovery.
- `WHATSAPP_CAPTURE_GROUP_HISTORY` defaults to `true`.
  `WHATSAPP_HISTORY_JOIN_WAIT_MS` defaults to `5000`, integer `0` to `60000`.
  Late history replays before subsequent live traffic, but a few live messages
  may precede it after the wait expires. Replay never triggers or replies.
- PA responses use `WHATSAPP_PA_REPLY_DELAY_MIN_MS` (default `2000`) and
  `WHATSAPP_PA_REPLY_DELAY_MAX_MS` (default `5000`) before normal queue pacing.

See [README](../README.md#routing) for the full routing matrix.

## Status (debug)

### GET /api/v1/status

Connection view plus counts and non-secret setup status:

```json
{
  "connection": { "...": "connection view or null" },
  "shoppers": 3,
  "mappings": 5,
  "mcpConfigured": true,
  "setupComplete": true,
  "commonRoomName": "sept-common",
  "clientServiceAccountId": "client-sa"
}
```

Before setup, `setupComplete` is `false`, `commonRoomName` is `null`, and
`clientServiceAccountId` is **omitted entirely** (there is no client identity
yet). Once set up, the key is always present: it holds the configured id, or
`null` if setup completed without one. `setupComplete` means both required
values have been stored, not that the token or room permissions have been
verified against PromptQL. The Client SA token is never included.
