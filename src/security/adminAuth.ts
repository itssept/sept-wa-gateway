/**
 * Admin authentication for the management API. Every management endpoint is
 * authenticated with a single admin credential presented as a Bearer token (or
 * the x-gateway-admin-token header). Compared in constant time.
 *
 * This admin credential is SEPARATE from any PromptQL MCP credential and from
 * the per-shopper tokens — it authorizes gateway management only.
 */

import { constantTimeEqual } from "../crypto.ts";

const HEADER = "x-gateway-admin-token";

/** Extract the presented token from either Authorization: Bearer or the header. */
export function presentedToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const h = req.headers.get(HEADER);
  return h && h.length > 0 ? h : null;
}

/** True when the request carries the correct admin token. */
export function isAuthorized(req: Request, adminToken: string): boolean {
  const presented = presentedToken(req);
  if (!presented) return false;
  return constantTimeEqual(presented, adminToken);
}
