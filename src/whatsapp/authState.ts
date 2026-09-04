/**
 * SQLite-backed Baileys AuthenticationState. Mirrors `useMultiFileAuthState`,
 * but persists to `whatsapp_session_state` keyed by (connection_id, key_type,
 * key_id), every value AES-256-GCM encrypted at rest under DATA_ENCRYPTION_KEY.
 *
 *  - creds:  key_type='creds', key_id=''
 *  - keys:   key_type=<signal namespace>, key_id=<id>
 *
 * `creds.update` MUST be persisted immediately — the socket owner calls
 * saveCreds() on that event. `keys.set` fires per message and is written as a
 * single batched transaction.
 */

import type { Database } from "bun:sqlite";
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
import { encrypt, decryptToString } from "../crypto.ts";
import { nowIso } from "../util.ts";

type SignalKeyType = keyof SignalDataTypeMap;

export interface AuthStateHandle {
  state: AuthenticationState;
  saveCreds: () => void;
  clear: () => void;
}

function readValue(
  db: Database,
  connectionId: string,
  keyType: string,
  keyId: string,
  encKey: Buffer,
): unknown | null {
  const row = db
    .query<{ value_encrypted: Uint8Array }, [string, string, string]>(
      `SELECT value_encrypted FROM whatsapp_session_state
       WHERE connection_id = ? AND key_type = ? AND key_id = ?`,
    )
    .get(connectionId, keyType, keyId);
  if (!row) return null;
  const json = decryptToString(Buffer.from(row.value_encrypted), encKey);
  return JSON.parse(json, BufferJSON.reviver);
}

function writeValue(
  db: Database,
  connectionId: string,
  keyType: string,
  keyId: string,
  value: unknown,
  encKey: Buffer,
): void {
  const json = JSON.stringify(value, BufferJSON.replacer);
  const enc = encrypt(json, encKey);
  db.run(
    `INSERT INTO whatsapp_session_state (connection_id, key_type, key_id, value_encrypted, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, key_type, key_id)
     DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [connectionId, keyType, keyId, enc, nowIso()],
  );
}

function deleteValue(
  db: Database,
  connectionId: string,
  keyType: string,
  keyId: string,
): void {
  db.run(
    `DELETE FROM whatsapp_session_state WHERE connection_id = ? AND key_type = ? AND key_id = ?`,
    [connectionId, keyType, keyId],
  );
}

export function useSqliteAuthState(
  db: Database,
  connectionId: string,
  encKey: Buffer,
): AuthStateHandle {
  const storedCreds = readValue(db, connectionId, "creds", "", encKey) as
    | AuthenticationCreds
    | null;
  const creds: AuthenticationCreds = storedCreds ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: (type, ids) => {
        const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          let value = readValue(db, connectionId, type, id, encKey) as
            | SignalDataTypeMap[typeof type]
            | null;
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
            ) as unknown as SignalDataTypeMap[typeof type];
          }
          if (value) result[id] = value;
        }
        return result;
      },
      set: (data) => {
        const tx = db.transaction(() => {
          for (const category in data) {
            const type = category as SignalKeyType;
            const entries = data[type];
            if (!entries) continue;
            for (const id in entries) {
              const value = entries[id];
              if (value) {
                writeValue(db, connectionId, type, id, value, encKey);
              } else {
                deleteValue(db, connectionId, type, id);
              }
            }
          }
        });
        tx();
      },
    },
  };

  return {
    state,
    saveCreds: () => {
      writeValue(db, connectionId, "creds", "", creds, encKey);
    },
    clear: () => {
      db.run(`DELETE FROM whatsapp_session_state WHERE connection_id = ?`, [connectionId]);
    },
  };
}
