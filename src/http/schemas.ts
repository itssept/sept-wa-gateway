/**
 * Zod schemas for the management API I/O boundary. Every request body is
 * validated against these before it reaches a repository.
 */

import { z } from "zod";

export const CreateShopper = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(4).max(32), // canonicalized server-side
  // Caller-owned PromptQL room_name. Mandatory: the gateway no longer derives a
  // room from the shopper id, so the caller owns the room semantics. Stored
  // verbatim; PromptQL validates the value.
  roomName: z.string().min(1).max(80),
  // The MCP-scoped service-account token. Stored encrypted, never returned.
  mcpToken: z.string().min(8).max(4096),
  // Optional non-secret PromptQL service-account identifier for audit/attribution.
  serviceAccountId: z.string().max(256).optional(),
});
export type CreateShopperInput = z.infer<typeof CreateShopper>;

export const RotateCredential = z.object({
  mcpToken: z.string().min(8).max(4096),
  serviceAccountId: z.string().max(256).optional(),
});
export type RotateCredentialInput = z.infer<typeof RotateCredential>;

export const SetShopperStatus = z.object({
  status: z.enum(["enabled", "disabled"]),
});

export const LinkConnection = z.object({
  phone: z.string().min(4).max(32), // canonicalized server-side
  deviceLabel: z.string().max(80).optional(),
});
export type LinkConnectionInput = z.infer<typeof LinkConnection>;
