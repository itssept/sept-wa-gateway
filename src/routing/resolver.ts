/** Sender identity and group owner selection. Ownership never follows tags. */
import { isGroupJid } from "../util.ts";
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
    const mapping = isGroupJid(chatJid) ? null : this.mappings.get(connectionId, chatJid);
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

  /** Resolve a stored owner for responding on their behalf. */
  resolveShopper(shopperId: string): ResolveResult {
    return this.finalize(this.shoppers.getById(shopperId), "sender");
  }

  registered(phone: string | null | undefined): Shopper | null {
    const shopper = phone ? this.shoppers.getByPhone(phone) : null;
    return shopper?.status === "enabled" ? shopper : null;
  }

  byId(id: string | null): Shopper | null {
    return id ? this.shoppers.getById(id) : null;
  }

  groupOwner(phones: string[], addedByPhone: string | null): Shopper | null {
    const members = this.shoppers.list().filter((s) => s.status === "enabled" && phones.includes(s.phoneE164));
    return members.find((s) => s.phoneE164 === addedByPhone) ?? members[0] ?? null;
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
