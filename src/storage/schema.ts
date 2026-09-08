/**
 * Gateway SQLite schema. All gateway state lives in the gateway's own SQLite
 * file (on a durable/mounted volume in cloud). Migrations are an ordered,
 * append-only list; the
 * runner (./db.ts) records applied versions in `_gateway_migrations` and applies
 * the rest inside a transaction.
 *
 * Identity model (see README §Core identity model):
 *   - `shopper`            registered shopper metadata + status
 *   - `shopper_credential` per-shopper MCP service-account token, ENCRYPTED at rest
 *   - `chat_mapping`       WhatsApp chat/group jid -> shopper (routing)
 *   - `audit_log`          create/rotate/revoke/disable/mapping events
 *   - `mcp_workflow`       submit+poll correlation state (durable outbound routing)
 *
 * WhatsApp transport tables mirror the reference gateway:
 *   - `whatsapp_connection`     connection_id -> number_e164 + link state
 *   - `whatsapp_session_state`  Baileys creds/keys, ENCRYPTED at rest
 *   - `whatsapp_message_store`  capture-all (incl. fromMe for loop prevention)
 *   - `whatsapp_outbound_log`   send idempotency
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: /* sql */ `
      -- ---- WhatsApp transport ------------------------------------------------
      CREATE TABLE IF NOT EXISTS whatsapp_connection (
        connection_id TEXT PRIMARY KEY,
        number_e164   TEXT NOT NULL,
        link_status   TEXT NOT NULL DEFAULT 'pending', -- pending | linked | logged_out
        link_method   TEXT,                            -- pairing
        device_label  TEXT,
        linked_at     TEXT,                            -- when the socket first opened linked
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_whatsapp_connection_number
        ON whatsapp_connection (number_e164);

      CREATE TABLE IF NOT EXISTS whatsapp_session_state (
        connection_id   TEXT NOT NULL,
        key_type        TEXT NOT NULL,   -- 'creds' or Signal namespace
        key_id          TEXT NOT NULL,   -- '' for creds
        value_encrypted BLOB NOT NULL,   -- AES-256-GCM under DATA_ENCRYPTION_KEY
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (connection_id, key_type, key_id)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_message_store (
        id                TEXT PRIMARY KEY,   -- uuid
        connection_id     TEXT NOT NULL,
        chat_jid          TEXT NOT NULL,
        sender_jid        TEXT NOT NULL,
        sender_phone_e164 TEXT,
        message_id        TEXT NOT NULL,      -- WhatsApp message key id
        ts                INTEGER NOT NULL,   -- epoch ms
        msg_type          TEXT NOT NULL,
        text              TEXT,
        from_me           INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_store_conn_chat_msgid
        ON whatsapp_message_store (connection_id, chat_jid, message_id);
      CREATE INDEX IF NOT EXISTS ix_msg_store_conn_chat_ts
        ON whatsapp_message_store (connection_id, chat_jid, ts DESC);

      -- Send idempotency. Keyed on (connection_id, idempotency_key). The key is
      -- the inbound WhatsApp message id that triggered the response, so a retry
      -- of the same inbound never double-sends. claim_token fences concurrent
      -- reclaims of a stale 'pending' row.
      CREATE TABLE IF NOT EXISTS whatsapp_outbound_log (
        connection_id        TEXT NOT NULL,
        idempotency_key      TEXT NOT NULL,
        chat_jid             TEXT,
        whatsapp_message_ref TEXT,
        status               TEXT NOT NULL,   -- pending | sent | failed
        claim_token          TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (connection_id, idempotency_key)
      );

      -- ---- Identity model ----------------------------------------------------
      CREATE TABLE IF NOT EXISTS shopper (
        id            TEXT PRIMARY KEY,        -- generated shopper id (uuid)
        name          TEXT NOT NULL,
        phone_e164    TEXT NOT NULL,           -- normalized, canonical
        room_name     TEXT NOT NULL,           -- caller-owned PromptQL room_name; gateway does not derive it
        status        TEXT NOT NULL DEFAULT 'enabled', -- enabled | disabled
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      -- One shopper per canonical phone number.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_shopper_phone
        ON shopper (phone_e164);

      -- Per-shopper MCP service-account credential. The token is stored ONLY as
      -- an AES-256-GCM ciphertext; token_fingerprint is a one-way sha256 for
      -- audit/lookup without disclosure. label names the service account (e.g.
      -- 'shopper' vs a future 'assistant' identity) — schema keeps room for >1.
      CREATE TABLE IF NOT EXISTS shopper_credential (
        id                  TEXT PRIMARY KEY,   -- uuid
        shopper_id          TEXT NOT NULL,
        label               TEXT NOT NULL DEFAULT 'shopper',
        service_account_id  TEXT,               -- PromptQL service-account identifier (non-secret)
        token_encrypted     BLOB NOT NULL,      -- MCP-scoped token, encrypted at rest
        token_fingerprint   TEXT NOT NULL,      -- sha256(token) hex, for audit
        status              TEXT NOT NULL DEFAULT 'active', -- active | revoked
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        FOREIGN KEY (shopper_id) REFERENCES shopper(id)
      );
      -- Exactly one ACTIVE credential per (shopper, label) at a time; rotation
      -- revokes the old row before inserting the new one.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_shopper_cred_active
        ON shopper_credential (shopper_id, label)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS ix_shopper_cred_shopper
        ON shopper_credential (shopper_id);

      -- WhatsApp chat/group jid -> shopper. Works for both DM and group jids
      -- (chat-jid mapping model). connection_id is a routing key, not an authz
      -- boundary. A jid maps to at most one shopper (ambiguity is rejected).
      CREATE TABLE IF NOT EXISTS chat_mapping (
        connection_id TEXT NOT NULL,
        chat_jid      TEXT NOT NULL,
        shopper_id    TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'enabled', -- enabled | disabled
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (connection_id, chat_jid),
        FOREIGN KEY (shopper_id) REFERENCES shopper(id)
      );
      CREATE INDEX IF NOT EXISTS ix_chat_mapping_shopper
        ON chat_mapping (shopper_id);

      -- Auditable management events. No raw secrets — only fingerprints/refs.
      CREATE TABLE IF NOT EXISTS audit_log (
        id           TEXT PRIMARY KEY,   -- uuid
        ts           TEXT NOT NULL,
        action       TEXT NOT NULL,      -- shopper.create | credential.rotate | ...
        actor        TEXT NOT NULL,      -- 'admin' (single admin credential for now)
        subject_type TEXT,               -- shopper | mapping | credential | connection
        subject_id   TEXT,
        detail       TEXT,               -- JSON, MUST NOT contain raw secrets
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log (ts DESC);

      -- Submit+poll correlation. When an inbound message is submitted to
      -- PromptQL via MCP, we persist the correlation so the eventual result can
      -- be routed back to the originating chat from DURABLE state, not just
      -- transient request state.
      CREATE TABLE IF NOT EXISTS mcp_workflow (
        id                 TEXT PRIMARY KEY,   -- uuid, our correlation id
        connection_id      TEXT NOT NULL,
        chat_jid           TEXT NOT NULL,
        shopper_id         TEXT NOT NULL,
        inbound_message_id TEXT NOT NULL,      -- doubles as outbound idempotency key
        remote_ref         TEXT,               -- PromptQL-side handle returned by submit tool
        status             TEXT NOT NULL DEFAULT 'submitted', -- submitted | done | failed
        result_text        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_mcp_workflow_status
        ON mcp_workflow (status, created_at);
    `,
  },
  {
    version: 2,
    name: "chat_bot",
    sql: /* sql */ `
      -- Per-chat PromptQL bot (thread) handle for conversational continuity.
      -- PromptQL's product concept is a "bot"; the MCP wire still keys it by
      -- thread_id (compat). The first inbound message on a chat starts a bot;
      -- later messages pass this thread_id to continue the same conversation.
      CREATE TABLE IF NOT EXISTS chat_bot (
        connection_id TEXT NOT NULL,
        chat_jid      TEXT NOT NULL,
        shopper_id    TEXT NOT NULL,
        thread_id     TEXT NOT NULL,       -- PromptQL bot handle (legacy name)
        room_name     TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (connection_id, chat_jid)
      );
    `,
  },
  {
    version: 3,
    name: "group_metadata",
    sql: /* sql */ `
      -- Persisted group metadata, feeding Baileys' cachedGroupMetadata so group
      -- sends don't refetch/re-encrypt per participant (anti-ban). Refreshed on
      -- groups.update / group-participants.update and lazily on cache miss /
      -- staleness (TTL = WHATSAPP_GROUP_META_TTL_MS).
      CREATE TABLE IF NOT EXISTS whatsapp_group_metadata (
        connection_id TEXT NOT NULL,
        group_jid     TEXT NOT NULL,
        subject       TEXT,
        participants  TEXT,               -- JSON array of {jid, phone_e164, admin}
        raw_metadata  TEXT,               -- serialized Baileys GroupMetadata
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (connection_id, group_jid)
      );
    `,
  },

  {
    version: 4,
    name: "transient_media_delivery",
    sql: /* sql */ `
      -- Reserved migration version. An earlier unmerged implementation used
      -- this version for persistent media pointers. Media is now transient and
      -- requires no schema changes; keeping the version avoids future reuse.
      SELECT 1;
    `,
  },
  {
    version: 5,
    name: "group_relay_pause",
    sql: /* sql */ `
      ALTER TABLE chat_bot ADD COLUMN relay_paused_at TEXT;
    `,
  },
  {
    version: 6,
    name: "gateway_settings",
    sql: /* sql */ `
      -- One client identity and common public room for the whole gateway.
      -- Existing shoppers keep their shopper token; re-registration supplies PA.
      CREATE TABLE gateway_settings (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        client_token_encrypted BLOB NOT NULL,
        common_room_name       TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
    `,
  },
];
