# Admin API

The management API. A PromptQL project (or any admin caller) uses it to drive
the gateway: link a WhatsApp number, register shoppers, and map chats to
shoppers.

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
- Create / rotate / revoke / disable / mapping changes are recorded in
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
| GET | `/api/v1/mappings` | List chat mappings. |
| POST | `/api/v1/mappings` | Upsert a chat → shopper mapping. |
| POST | `/api/v1/mappings/:chatJid/status` | Enable / disable a mapping. |
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
phone** — an existing shopper returns `200`, a new one returns `201`. Response
includes the shopper and the credential's non-secret info (`tokenFingerprint`,
never the raw token).

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string (1–200) | yes | Shopper display name. |
| `phone` | string | yes | Canonicalized to E.164 server-side. `422` if invalid. |
| `mcpToken` | string (8–4096) | yes | MCP-scoped service-account token. Stored encrypted, never returned. |
| `serviceAccountId` | string (≤256) | no | Non-secret PromptQL service-account id for audit/attribution. |

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/shoppers \
  -d '{"name":"Rakesh","phone":"+14155551212","mcpToken":"<mcp-scoped-token>"}'
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

## Mappings

A mapping binds a WhatsApp chat/group jid to exactly one shopper.

### GET /api/v1/mappings

List chat mappings. Returns `{ "mappings": [...] }`.

### POST /api/v1/mappings

Upsert a chat → shopper mapping. `422` if `shopperId` does not exist.

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `chatJid` | string (3–128) | yes | The WhatsApp chat/group jid. |
| `shopperId` | string (1–64) | yes | Must reference an existing shopper. |
| `status` | `enabled` \| `disabled` | no | Defaults to `enabled`. |

```bash
curl -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -X POST $BASE/api/v1/mappings \
  -d '{"chatJid":"14155551212@s.whatsapp.net","shopperId":"<shopper-id>"}'
```

### POST /api/v1/mappings/:chatJid/status

Enable or disable a mapping. `:chatJid` is URL-encoded. `404` if not found.

Body: `{ "status": "enabled" | "disabled" }`

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
