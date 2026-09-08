/**
 * Management API (spec direction: resource-oriented, versioned). Routes:
 *
 *   GET    /health                                  (unauthenticated)
 *   POST   /api/v1/setup                            set Client SA token + common room
 *   POST   /api/v1/shoppers                         register shopper + shopper/PA credentials
 *   GET    /api/v1/shoppers                         list shoppers (non-secret)
 *   GET    /api/v1/shoppers/:id                     read one (non-secret)
 *   POST   /api/v1/shoppers/:id/status              enable/disable
 *   POST   /api/v1/shoppers/:id/credential/rotate   rotate MCP token
 *   POST   /api/v1/shoppers/:id/credential/revoke   revoke MCP token
 *   GET    /api/v1/status                           connection + counts (debug)
 *
 * Every /api/v1 route requires the admin token (constant-time). Bodies are
 * validated with Zod. Secrets are never returned after creation, never logged.
 *
 * NOTE: chat->shopper mappings are an INTERNAL routing mechanism (see
 * `src/routing/resolver.ts`) and are deliberately NOT exposed over the API —
 * API users work in shoppers + phone numbers, not WhatsApp jids/lids. The
 * `MappingRepo` + `chat_mapping` table remain for internal use.
 */

import type { z } from "zod";
import type { AppContext } from "../context.ts";
import type { WhatsAppConnection } from "../whatsapp/socket.ts";
import { isAuthorized } from "../security/adminAuth.ts";
import {
  CreateShopper,
  SetupGateway,
  RotateCredential,
  RevokeCredential,
  SetShopperStatus,
  LinkConnection,
} from "./schemas.ts";
import { sha256Hex } from "../crypto.ts";
import { canonicalizeE164 } from "../util.ts";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

interface ApiDeps {
  ctx: AppContext;
  connection?: WhatsAppConnection;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

async function readJson<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) {
    return { ok: false, response: err(413, "request body too large") };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: err(400, "invalid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: err(422, "validation failed", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function makeHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  const { ctx, connection } = deps;
  const log = ctx.log.child({ component: "api" });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const resource = segments[0] === "api" ? segments[2] : segments[0];
    const startedAt = performance.now();

    const res = await route(req, url, segments, resource);

    // One access line per request. Method + resource only — the raw path can
    // carry a chatJid (PII). Latency in ms, rounded.
    log.info("request", {
      method: req.method,
      resource: resource ?? null,
      status: res.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return res;
  };

  async function route(
    req: Request,
    url: URL,
    segments: string[],
    resource: string | undefined,
  ): Promise<Response> {
    // Unauthenticated health check.
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" });
    }

    // Everything under /api/v1 requires admin auth.
    if (segments[0] !== "api" || segments[1] !== "v1") {
      return err(404, "not found");
    }
    if (!isAuthorized(req, ctx.config.adminToken)) {
      return err(401, "unauthorized");
    }

    try {
      if (resource === "setup" && segments.length === 3 && req.method === "POST") {
        const parsed = await readJson(req, SetupGateway);
        if (!parsed.ok) return parsed.response;
        const setup = ctx.db.transaction(() => {
          const status = ctx.gatewaySettings.set(parsed.data.clientMcpToken, parsed.data.commonRoomName);
          ctx.audit.record("gateway.setup", {
            subjectType: "gateway",
            detail: { clientTokenFingerprint: sha256Hex(parsed.data.clientMcpToken) },
          });
          return status;
        })();
        return json(setup);
      }
      if (resource === "shoppers") {
        return await handleShoppers(req, segments.slice(3), ctx);
      }
      if (resource === "connection") {
        return await handleConnection(req, segments.slice(3), ctx, connection);
      }
      if (resource === "status" && req.method === "GET") {
        return json({
          connection: connection ? connectionView(ctx, connection) : null,
          shoppers: ctx.shoppers.list().length,
          mappings: ctx.mappings.list().length,
          mcpConfigured: Boolean(ctx.config.mcp.endpoint),
          ...ctx.gatewaySettings.getStatus(),
        });
      }
      return err(404, "not found");
    } catch (e) {
      // Log method + resource only — the raw path can carry a chatJid (PII).
      log.error("request error", { method: req.method, resource, err: e });
      return err(500, "internal error");
    }
  }
}

/** Non-secret view of the WhatsApp connection for the API. */
function connectionView(ctx: AppContext, connection: WhatsAppConnection) {
  return {
    connectionId: ctx.config.connectionId,
    number: connection.number || null,
    status: connection.status, // pending | linked | logged_out
    linkedAtMs: connection.linkedAtMs,
    // The pairing code is short-lived and only present while pairing.
    pairingCode: connection.pairingCode ?? null,
  };
}

/**
 * Connection management — lets a PromptQL project (or any admin caller) drive
 * linking over HTTP instead of env-at-boot:
 *   GET  /api/v1/connection            status + current pairing code
 *   POST /api/v1/connection/link       start pairing for a number (wipes session)
 *   POST /api/v1/connection/unlink     stop + wipe session so a new number links
 *
 * After link, poll GET /api/v1/connection for `pairingCode`, enter it on the
 * phone (Linked Devices -> Link with phone number), then poll until
 * status="linked".
 */
async function handleConnection(
  req: Request,
  rest: string[],
  ctx: AppContext,
  connection: WhatsAppConnection | undefined,
): Promise<Response> {
  if (!connection) return err(503, "WhatsApp connection not initialized");

  // GET /api/v1/connection
  if (rest.length === 0 && req.method === "GET") {
    return json({ connection: connectionView(ctx, connection) });
  }

  // POST /api/v1/connection/link
  if (rest.length === 1 && rest[0] === "link" && req.method === "POST") {
    if (!ctx.gatewaySettings.getStatus().setupComplete) {
      return err(409, "gateway setup required: POST /api/v1/setup with clientMcpToken and commonRoomName");
    }
    const parsed = await readJson(req, LinkConnection);
    if (!parsed.ok) return parsed.response;
    const canonical = canonicalizeE164(parsed.data.phone);
    if (!canonical) return err(422, "phone is not a valid E.164 number");
    await connection.link(canonical, parsed.data.deviceLabel);
    ctx.audit.record("connection.link", {
      subjectType: "connection",
      subjectId: ctx.config.connectionId,
      detail: { requested: true },
    });
    // The pairing code is issued asynchronously a moment after the socket opens;
    // the caller polls GET /api/v1/connection for it.
    return json({ connection: connectionView(ctx, connection) }, 202);
  }

  // POST /api/v1/connection/unlink
  if (rest.length === 1 && rest[0] === "unlink" && req.method === "POST") {
    connection.unlink();
    ctx.audit.record("connection.logged_out", {
      subjectType: "connection",
      subjectId: ctx.config.connectionId,
      detail: { unlinkedByAdmin: true },
    });
    return json({ connection: connectionView(ctx, connection) });
  }

  return err(404, "not found");
}

async function handleShoppers(
  req: Request,
  rest: string[],
  ctx: AppContext,
): Promise<Response> {
  // POST /api/v1/shoppers
  if (rest.length === 0 && req.method === "POST") {
    if (!ctx.gatewaySettings.getStatus().setupComplete) {
      return err(409, "gateway setup required: POST /api/v1/setup with clientMcpToken and commonRoomName");
    }
    const parsed = await readJson(req, CreateShopper);
    if (!parsed.ok) return parsed.response;
    const { name, phone, roomName, mcpToken, serviceAccountId, paMcpToken, paServiceAccountId } = parsed.data;
    const canonical = canonicalizeE164(phone);
    if (!canonical) return err(422, "phone is not a valid E.164 number");

    // Keep registration and both identities atomic, including re-registration.
    const { shopper, created, cred, paCred } = ctx.db.transaction(() => {
      const { shopper, created } = ctx.shoppers.register(name, canonical, roomName);
      const cred = ctx.credentials.setActive(shopper.id, mcpToken, {
        label: "shopper",
        serviceAccountId: serviceAccountId ?? null,
      });
      const paCred = ctx.credentials.setActive(shopper.id, paMcpToken, {
        label: "pa",
        serviceAccountId: paServiceAccountId ?? null,
      });
      ctx.audit.record("shopper.create", {
        subjectType: "shopper",
        subjectId: shopper.id,
        detail: {
          created,
          credentialFingerprint: cred.tokenFingerprint,
          paCredentialFingerprint: paCred.tokenFingerprint,
        },
      });
      return { shopper, created, cred, paCred };
    })();
    ctx.adapter.invalidate(shopper.id);
    return json(
      { shopper, credential: cred, paCredential: paCred },
      created ? 201 : 200,
    );
  }

  // GET /api/v1/shoppers
  if (rest.length === 0 && req.method === "GET") {
    return json({ shoppers: ctx.shoppers.list() });
  }

  const id = rest[0];
  if (!id) return err(404, "not found");

  // GET /api/v1/shoppers/:id
  if (rest.length === 1 && req.method === "GET") {
    const shopper = ctx.shoppers.getById(id);
    if (!shopper) return err(404, "shopper not found");
    return json({ shopper, credentials: ctx.credentials.listInfo(id) });
  }

  // POST /api/v1/shoppers/:id/status
  if (rest.length === 2 && rest[1] === "status" && req.method === "POST") {
    const parsed = await readJson(req, SetShopperStatus);
    if (!parsed.ok) return parsed.response;
    const shopper = ctx.shoppers.setStatus(id, parsed.data.status);
    if (!shopper) return err(404, "shopper not found");
    ctx.audit.record(parsed.data.status === "disabled" ? "shopper.disable" : "shopper.enable", {
      subjectType: "shopper",
      subjectId: id,
    });
    return json({ shopper });
  }

  // POST /api/v1/shoppers/:id/credential/rotate
  if (
    rest.length === 3 &&
    rest[1] === "credential" &&
    rest[2] === "rotate" &&
    req.method === "POST"
  ) {
    if (!ctx.shoppers.getById(id)) return err(404, "shopper not found");
    const parsed = await readJson(req, RotateCredential);
    if (!parsed.ok) return parsed.response;
    const cred = ctx.credentials.setActive(id, parsed.data.mcpToken, {
      label: parsed.data.role,
      serviceAccountId: parsed.data.serviceAccountId ?? null,
    });
    ctx.adapter.invalidate(id); // drop any cached MCP session using the old token
    ctx.audit.record("credential.rotate", {
      subjectType: "credential",
      subjectId: cred.id,
      detail: { shopperId: id, role: parsed.data.role, fingerprint: cred.tokenFingerprint },
    });
    return json({ credential: cred });
  }

  // POST /api/v1/shoppers/:id/credential/revoke
  if (
    rest.length === 3 &&
    rest[1] === "credential" &&
    rest[2] === "revoke" &&
    req.method === "POST"
  ) {
    if (!ctx.shoppers.getById(id)) return err(404, "shopper not found");
    const parsed = await readJson(req, RevokeCredential);
    if (!parsed.ok) return parsed.response;
    const revoked = ctx.credentials.revokeActive(id, parsed.data.role);
    ctx.adapter.invalidate(id);
    ctx.audit.record("credential.revoke", {
      subjectType: "shopper",
      subjectId: id,
      detail: { role: parsed.data.role },
    });
    return json({ revoked });
  }

  return err(404, "not found");
}

