/**
 * Gateway entrypoint. Wires config -> context -> WhatsApp connection -> routing
 * -> HTTP server, and starts the Baileys link (pairing code printed to stdout).
 *
 * Graceful shutdown closes the websocket with ws.close() (NEVER logout()) so the
 * session survives to the next boot.
 */

import { loadConfig } from "../config.ts";
import { createContext } from "../context.ts";
import { WhatsAppConnection } from "../whatsapp/socket.ts";
import { AntiBanQueue } from "../whatsapp/antiBan.ts";
import { InboundRouter } from "../routing/inboundRouter.ts";
import { OutboundDispatcher } from "../routing/outboundDispatcher.ts";
import { makeHandler } from "./adminApi.ts";
import { maskNumber } from "../util.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);

  const antiBan = new AntiBanQueue({
    sendRatePerSec: config.sendRatePerSec,
    warmupDays: config.warmupDays,
    maxPendingPerConnection: config.maxPendingSendsPerConnection,
  });

  // The connection needs the router; the router needs the dispatcher; the
  // dispatcher needs the connection. Break the cycle by creating the connection
  // first with a deferred onInbound, then wiring the router once all exist.
  let router: InboundRouter | null = null;

  const connection = new WhatsAppConnection(ctx.db, config, antiBan, {
    onInbound: (msg) => {
      void router?.handle(msg);
    },
    onLoggedOut: (connId) => {
      ctx.audit.record("connection.logged_out", {
        subjectType: "connection",
        subjectId: connId,
      });
      console.error(`[server] connection ${connId} logged out — re-link required.`);
    },
    onLinked: (connId) => {
      ctx.audit.record("connection.link", {
        subjectType: "connection",
        subjectId: connId,
      });
    },
    onPairingCode: (_connId, code) => {
      console.log(`\n==== WhatsApp pairing code: ${code} ====\n`);
    },
  });

  const dispatcher = new OutboundDispatcher(
    ctx.adapter,
    ctx.workflows,
    ctx.outboundLog,
    connection,
    config,
  );

  router = new InboundRouter(
    config,
    ctx.resolver,
    ctx.adapter,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    dispatcher,
    ctx.audit,
  );

  const handle = makeHandler({ ctx, connection });

  const server = Bun.serve({
    port: config.apiPort,
    hostname: config.apiHost,
    fetch: handle,
  });

  console.log(
    `[server] HTTP listening on http://${config.apiHost}:${config.apiPort}`,
  );
  console.log(
    `[server] MCP endpoint: ${config.mcp.endpoint || "(not configured — set PROMPTQL_PROJECT_URL)"}`,
  );

  // On boot we only RESUME an already-linked session (reconnect with the saved,
  // encrypted creds — no pairing). Pairing a NEW number happens exclusively via
  // POST /api/v1/connection/link, so a PromptQL project fully manages linking.
  if (connection.status === "linked") {
    console.log(
      `[server] resuming linked WhatsApp connection (${maskNumber(connection.number)}) ...`,
    );
    await connection.start();
  } else {
    console.log(
      "[server] no linked session — waiting for POST /api/v1/connection/link",
    );
  }

  const shutdown = () => {
    console.log("[server] shutting down (ws.close, session preserved) ...");
    connection.stop();
    server.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[server] fatal: ${String(err)}`);
  process.exit(1);
});
