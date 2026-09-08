/**
 * Gateway-wide setup. The Client SA token uses the same AES-256-GCM key as
 * shopper credentials. Only getClientToken exposes plaintext, for MCP use.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { GatewaySetupStatus } from "../domain/types.ts";
import { encrypt, decryptToString } from "../crypto.ts";
import { nowIso } from "../util.ts";

const SettingsInput = z.object({
  clientMcpToken: z.string().min(8).max(4096).refine((token) => token.trim().length > 0),
  commonRoomName: z.string().min(1).max(80).refine((name) => name.trim().length > 0),
  clientServiceAccountId: z.string().max(256).nullable(),
});
const SettingsRow = z.object({
  client_token_encrypted: z.instanceof(Uint8Array),
  common_room_name: SettingsInput.shape.commonRoomName,
  client_service_account_id: z.string().nullable(),
});
type Row = z.infer<typeof SettingsRow>;

export class GatewaySettingsRepo {
  constructor(
    private readonly db: Database,
    private readonly encKey: Buffer,
  ) {}

  /** Replace all settings together; partial setup is never persisted. */
  set(
    clientMcpToken: string,
    commonRoomName: string,
    clientServiceAccountId: string | null = null,
  ): GatewaySetupStatus {
    const input = SettingsInput.parse({ clientMcpToken, commonRoomName, clientServiceAccountId });
    const ts = nowIso();
    this.db.run(
      `INSERT INTO gateway_settings
         (id, client_token_encrypted, common_room_name, client_service_account_id, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         client_token_encrypted = excluded.client_token_encrypted,
         common_room_name = excluded.common_room_name,
         client_service_account_id = excluded.client_service_account_id,
         updated_at = excluded.updated_at`,
      [encrypt(input.clientMcpToken, this.encKey), input.commonRoomName, input.clientServiceAccountId, ts, ts],
    );
    return this.getStatus();
  }

  getStatus(): GatewaySetupStatus {
    const row = this.getRow();
    if (row === null) {
      // Setup not done: no client identity to report at all.
      return { setupComplete: false, commonRoomName: null };
    }
    // Setup done: always report the id key (null when no id was configured).
    return {
      setupComplete: true,
      commonRoomName: row.common_room_name,
      clientServiceAccountId: row.client_service_account_id ?? null,
    };
  }

  getCommonRoomName(): string | null {
    return this.getRow()?.common_room_name ?? null;
  }

  /** Never log or persist the returned plaintext. Null means setup is missing. */
  getClientToken(): string | null {
    const row = this.getRow();
    return row ? decryptToString(Buffer.from(row.client_token_encrypted), this.encKey) : null;
  }

  private getRow(): Row | null {
    const row = this.db.query<Row, []>(
      "SELECT client_token_encrypted, common_room_name, client_service_account_id FROM gateway_settings WHERE id = 1",
    ).get();
    return row ? SettingsRow.parse(row) : null;
  }
}
