/**
 * Shopper + mapping domain types. These are the gateway's own routing metadata,
 * kept deliberately free of PromptQL business logic.
 */

export type ShopperStatus = "enabled" | "disabled";
export type CredentialStatus = "active" | "revoked";
export type MappingStatus = "enabled" | "disabled";

export interface Shopper {
  id: string;
  name: string;
  phoneE164: string;
  /** Caller-owned PromptQL room_name. The gateway stores it verbatim and never derives it. */
  roomName: string;
  status: ShopperStatus;
  createdAt: string;
  updatedAt: string;
}

/** Non-secret view of a credential — never carries the token. */
export interface CredentialInfo {
  id: string;
  shopperId: string;
  label: string;
  serviceAccountId: string | null;
  tokenFingerprint: string;
  status: CredentialStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMapping {
  connectionId: string;
  chatJid: string;
  shopperId: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

/** Result of resolving an inbound chat jid to a shopper for processing. */
export type ResolveResult =
  | { ok: true; shopper: Shopper; via: "mapping" | "sender" }
  | {
      ok: false;
      reason:
        | "unmapped"
        | "unregistered_sender"
        | "mapping_disabled"
        | "shopper_disabled"
        | "no_active_credential";
    };
