/**
 * Resolve a WhatsApp chat jid to exactly one enabled shopper with an active MCP
 * credential. Rejection is explicit and typed so the caller can log the reason
 * and silently drop (no WhatsApp reply — respects anti-ban / no unsolicited).
 *
 * Resolution order:
 *   1. An explicit chat->shopper mapping (admin-set) wins, if present. This is
 *      the original, strongest trust boundary and stays as an override.
 *   2. Otherwise, auto-resolve by the message SENDER's phone number: a DM's
 *      sender is the chat; a group message's sender is the participant. If that
 *      number is a registered, enabled shopper with an active credential, route
 *      as them.
 *
 * NOTE (trust model): step 2 takes shopper identity from the WhatsApp message
 * (the sender's number), which the manual-mapping model deliberately avoided.
 * This is an intentional override for the pilot — see AGENTS.md / README. It is
 * safe-ish because WhatsApp verifies the account owns its number; unregistered
 * senders (including everyone else in a group) still fall through to a drop.
 */

import type { ResolveResult } from "../domain/types.ts";
import type { Shopper } from "../domain/types.ts";
import type { ShopperRepo } from "../storage/shopperRepo.ts";
import type { MappingRepo } from "../storage/mappingRepo.ts";
import type { CredentialStore } from "../storage/credentialStore.ts";

export class ShopperResolver {
  constructor(
    private readonly shoppers: ShopperRepo,
    private readonly mappings: MappingRepo,
    private readonly credentials: CredentialStore,
  ) {}

  /**
   * @param senderPhoneE164 the canonical phone of the message sender (participant
   *   in a group, chat in a DM), or null if it could not be derived. Used only
   *   for the auto-resolve fallback when no explicit mapping exists.
   */
  resolve(
    connectionId: string,
    chatJid: string,
    senderPhoneE164?: string | null,
  ): ResolveResult {
    const mapping = this.mappings.get(connectionId, chatJid);
    if (mapping) {
      if (mapping.status !== "enabled") return { ok: false, reason: "mapping_disabled" };
      const shopper = this.shoppers.getById(mapping.shopperId);
      return this.finalize(shopper, "mapping");
    }

    // No explicit mapping: fall back to the sender's registered identity.
    if (senderPhoneE164) {
      const shopper = this.shoppers.getByPhone(senderPhoneE164);
      if (shopper) return this.finalize(shopper, "sender");
      return { ok: false, reason: "unregistered_sender" };
    }

    return { ok: false, reason: "unmapped" };
  }

  /** Shared enabled + has-active-credential gate for a resolved shopper. */
  private finalize(shopper: Shopper | null, via: "mapping" | "sender"): ResolveResult {
    if (!shopper || shopper.status !== "enabled") {
      return { ok: false, reason: "shopper_disabled" };
    }
    const cred = this.credentials.getActiveInfo(shopper.id);
    if (!cred) return { ok: false, reason: "no_active_credential" };
    return { ok: true, shopper, via };
  }
}
