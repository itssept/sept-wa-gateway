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
import { rootLogger } from "../logger.ts";
import { maskNumber } from "../util.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const log = ctx.log.child({ component: "server" });

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
      log.error("connection logged out — re-link required", { connectionId: connId });
    },
    onLinked: (connId) => {
      ctx.audit.record("connection.link", {
        subjectType: "connection",
        subjectId: connId,
      });
    },
    onPairingCode: (_connId, code) => {
      // Operator-facing: the pairing code must be visible on stdout to link the
      // device. It is a short-lived linking secret, not persistent PII.
      console.log(`\n==== WhatsApp pairing code: ${code} ====\n`);
    },
  }, ctx.log);

  const dispatcher = new OutboundDispatcher(
    ctx.adapter,
    ctx.workflows,
    ctx.outboundLog,
    connection,
    config,
    ctx.log.child({ component: "outbound" }),
  );

  router = new InboundRouter(
    ctx.resolver,
    ctx.adapter,
    ctx.workflows,
    ctx.chatBots,
    ctx.outboundLog,
    dispatcher,
    ctx.audit,
    ctx.log.child({ component: "inbound" }),
  );

  const handle = makeHandler({ ctx, connection });

  const server = Bun.serve({
    port: config.apiPort,
    hostname: config.apiHost,
    fetch: handle,
  });

  log.info("HTTP listening", { host: config.apiHost, port: config.apiPort });
  log.info("MCP endpoint", {
    endpoint: config.mcp.endpoint || null,
    configured: Boolean(config.mcp.endpoint),
  });

  // On boot we only RESUME an already-linked session (reconnect with the saved,
  // encrypted creds — no pairing). Pairing a NEW number happens exclusively via
  // POST /api/v1/connection/link, so a PromptQL project fully manages linking.
  if (connection.status === "linked") {
    log.info("resuming linked WhatsApp connection", {
      number: maskNumber(connection.number),
    });
    await connection.start();
  } else {
    log.info("no linked session — waiting for POST /api/v1/connection/link");
  }

  const shutdown = () => {
    log.info("shutting down (ws.close, session preserved)");
    connection.stop();
    server.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  rootLogger.child({ component: "server" }).error("fatal", { err });
  process.exit(1);
});
