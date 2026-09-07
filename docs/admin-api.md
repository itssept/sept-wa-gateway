# Admin API

The management API. A PromptQL project (or any admin caller) uses it to drive
the gateway: link a WhatsApp number and register shoppers. Callers work in
shoppers and phone numbers; WhatsApp jids/lids and chat routing are internal.

Base path: `/api/v1`. See the [README](../README.md) for the wider system
overview.

## Authentication

Every `/api/v1/*` endpoint requires the **admin token**
(`GATEWAY_ADMIN_TOKEN`), passed as a bearer token and compared in constant time:

```
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

- `GET /health` is the only unauthenticated route.
- The tunnel / ingress URL is **not** a security boundary — the admin token
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
- Shopper create / credential rotate / revoke / status changes are recorded in
  `audit_log`.

### Error shape

```json
{ "error": "<message>" }
```

| Status | Meaning |
|---|---|
| 400 | Invalid JSON body. |
| 401 | Missing or wrong admin token. |
| 404 | Unknown route or resource. |
| 413 | Request body too large. |
| 422 | Validation failed (`issues` array) or invalid E.164 phone / unknown `shopperId`. |
| 500 | Internal error. |
| 503 | WhatsApp connection not initialized (connection routes only). |

## Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (unauthenticated). |
| GET | `/api/v1/connection` | Connection status + current pairing code. |
| POST | `/api/v1/connection/link` | Start pairing for a number (wipes session, returns 202). |
| POST | `/api/v1/connection/unlink` | Stop + wipe session so a new number can link. |
| POST | `/api/v1/shoppers` | Register a shopper + set its MCP credential. Idempotent on phone. |
| GET | `/api/v1/shoppers` | List shoppers (non-secret). |
| GET | `/api/v1/shoppers/:id` | Read one shopper + its credential info. |
| POST | `/api/v1/shoppers/:id/status` | Enable / disable. |
| POST | `/api/v1/shoppers/:id/credential/rotate` | Rotate the MCP token. |
| POST | `/api/v1/shoppers/:id/credential/revoke` | Revoke the MCP token. |
| GET | `/api/v1/status` | Connection + counts (debug). |

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

Register a shopper and set (or rotate) its MCP credential. **Idempotent on
phone** — an existing shopper returns `200`, a new one returns `201`. On a
re-register the mutable fields (`name`, `roomName`) are updated to the new
values; a disabled shopper is never implicitly re-enabled. Response includes the
shopper and the credential's non-secret info (`tokenFingerprint`, never the raw
token).

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string (1–200) | yes | Shopper display name. |
| `phone` | string | yes | Canonicalized to E.164 server-side. `422` if invalid. |
| `roomName` | string (1–80) | yes | Caller-owned PromptQL `room_name` for this shopper. Stored verbatim and passed to PromptQL when starting the shopper's thread. The gateway does not derive it — PromptQL validates the value. |
| `mcpToken` | string (8–4096) | yes | MCP-scoped service-account token. Stored encrypted, never returned. |
| `serviceAccountId` | string (≤256) | no | Non-secret PromptQL service-account id for audit/attribution. |

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","roomName":"rakesh-room","mcpToken":"<mcp-scoped-token>"}'
```

### GET /api/v1/shoppers

List shoppers (non-secret). Returns `{ "shoppers": [...] }`.

### GET /api/v1/shoppers/:id

Read one shopper plus its credential info. `404` if not found. Returns
`{ "shopper": ..., "credentials": [...] }`.

### POST /api/v1/shoppers/:id/status

Enable or disable a shopper. `404` if not found.

Body: `{ "status": "enabled" | "disabled" }`

### POST /api/v1/shoppers/:id/credential/rotate

Rotate the MCP token. Drops any cached MCP session using the old token. `404` if
the shopper is not found.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `mcpToken` | string (8–4096) | yes | New MCP-scoped token. |
| `serviceAccountId` | string (≤256) | no | Non-secret service-account id. |

### POST /api/v1/shoppers/:id/credential/revoke

Revoke the active MCP token and drop any cached MCP session. `404` if the
shopper is not found. Returns `{ "revoked": <bool> }`.

## Routing (no API)

There is **no mappings API**. How an inbound WhatsApp chat resolves to a shopper
is an internal concern of the gateway, expressed in shoppers and phone numbers —
never in WhatsApp jids/lids, which API users do not see.

Resolution (internal, see `src/routing/resolver.ts`): a message auto-resolves by
the **sender's phone** (the participant in a group, the chat in a DM) to a
registered, enabled shopper. Senders that are not registered shoppers are
dropped. An internal chat→shopper mapping table exists for pinning specific
chats, but it is not manageable over the API.

## Status (debug)

### GET /api/v1/status

Connection view plus counts:

```json
{
  "connection": { "...": "connection view or null" },
  "shoppers": 3,
  "mappings": 5,
  "mcpConfigured": true
}
```
