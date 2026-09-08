/**
 * Zod schemas for the management API I/O boundary. Every request body is
 * validated against these before it reaches a repository.
 */

import { z } from "zod";
import { CredentialRoleSchema } from "../domain/types.ts";

const McpToken = z.string().min(8).max(4096)
  .refine((token) => token.trim().length > 0, "token must not be blank");
const RoomName = z.string().min(1).max(80)
  .refine((name) => name.trim().length > 0, "room name must not be blank");

export const SetupGateway = z.object({
  clientMcpToken: McpToken,
  commonRoomName: RoomName,
  // Optional non-secret PromptQL service-account identifier for the client,
  // mirroring the shopper/PA serviceAccountId. Surfaced in GET /api/v1/status.
  clientServiceAccountId: z.string().max(256).optional(),
}).strict();

export const CreateShopper = z.object({
  name: z.string().min(1).max(200).refine((name) => name.trim().length > 0, "name must not be blank"),
  phone: z.string().min(4).max(32), // canonicalized server-side
  // Caller-owned PromptQL room_name. Mandatory: the gateway no longer derives a
  // room from the shopper id, so the caller owns the room semantics. Stored
  // verbatim; PromptQL validates the value.
  roomName: RoomName,
  // The MCP-scoped service-account token. Stored encrypted, never returned.
  mcpToken: McpToken,
  // Optional non-secret PromptQL service-account identifier for audit/attribution.
  serviceAccountId: z.string().max(256).optional(),
  paMcpToken: McpToken,
  paServiceAccountId: z.string().max(256).optional(),
});
export type CreateShopperInput = z.infer<typeof CreateShopper>;

export const RotateCredential = z.object({
  role: CredentialRoleSchema,
  mcpToken: McpToken,
  serviceAccountId: z.string().max(256).optional(),
});
export type RotateCredentialInput = z.infer<typeof RotateCredential>;

export const RevokeCredential = z.object({
  role: CredentialRoleSchema,
});

export const SetShopperStatus = z.object({
  status: z.enum(["enabled", "disabled"]),
});

export const LinkConnection = z.object({
  phone: z.string().min(4).max(32), // canonicalized server-side
  deviceLabel: z.string().max(80).optional(),
});
export type LinkConnectionInput = z.infer<typeof LinkConnection>;
