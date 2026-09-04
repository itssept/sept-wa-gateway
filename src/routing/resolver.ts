/**
 * Resolve a WhatsApp chat jid to exactly one enabled shopper with an active MCP
 * credential. Rejection is explicit and typed so the caller can log the reason
 * and silently drop (no WhatsApp reply — respects anti-ban / no unsolicited).
 */

import type { ResolveResult } from "../domain/types.ts";
import type { ShopperRepo } from "../storage/shopperRepo.ts";
import type { MappingRepo } from "../storage/mappingRepo.ts";
import type { CredentialStore } from "../storage/credentialStore.ts";

export class ShopperResolver {
  constructor(
    private readonly shoppers: ShopperRepo,
    private readonly mappings: MappingRepo,
    private readonly credentials: CredentialStore,
  ) {}

  resolve(connectionId: string, chatJid: string): ResolveResult {
    const mapping = this.mappings.get(connectionId, chatJid);
    if (!mapping) return { ok: false, reason: "unmapped" };
    if (mapping.status !== "enabled") return { ok: false, reason: "mapping_disabled" };

    const shopper = this.shoppers.getById(mapping.shopperId);
    if (!shopper || shopper.status !== "enabled") {
      return { ok: false, reason: "shopper_disabled" };
    }
    const cred = this.credentials.getActiveInfo(shopper.id);
    if (!cred) return { ok: false, reason: "no_active_credential" };

    return { ok: true, shopper };
  }
}
