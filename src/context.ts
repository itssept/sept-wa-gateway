/**
 * Application context — single place that constructs the DB, repositories,
 * stores, adapter, and routing wiring. Both the HTTP server and tests build one.
 */

import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { openDatabase } from "./storage/db.ts";
import { ShopperRepo } from "./storage/shopperRepo.ts";
import { MappingRepo } from "./storage/mappingRepo.ts";
import { CredentialStore } from "./storage/credentialStore.ts";
import { AuditLog } from "./storage/auditLog.ts";
import { OutboundLog } from "./storage/outboundLog.ts";
import { McpWorkflowRepo } from "./storage/mcpWorkflowRepo.ts";
import { ChatBotRepo } from "./storage/chatBotRepo.ts";
import { PromptQlAdapter } from "./promptql/promptqlAdapter.ts";
import { ShopperResolver } from "./routing/resolver.ts";
import { createLogger, type Logger } from "./logger.ts";

export interface AppContext {
  config: Config;
  log: Logger;
  db: Database;
  shoppers: ShopperRepo;
  mappings: MappingRepo;
  credentials: CredentialStore;
  audit: AuditLog;
  outboundLog: OutboundLog;
  workflows: McpWorkflowRepo;
  chatBots: ChatBotRepo;
  adapter: PromptQlAdapter;
  resolver: ShopperResolver;
}

export function createContext(config: Config, db?: Database, log?: Logger): AppContext {
  const rootLog = log ?? createLogger({ level: config.logLevel });
  const database = db ?? openDatabase(config.dbPath);
  const shoppers = new ShopperRepo(database);
  const mappings = new MappingRepo(database);
  const credentials = new CredentialStore(database, config.dataEncryptionKey);
  const audit = new AuditLog(database);
  const outboundLog = new OutboundLog(database);
  const workflows = new McpWorkflowRepo(database);
  const chatBots = new ChatBotRepo(database);
  const adapter = new PromptQlAdapter({
    config,
    getToken: (shopperId) => credentials.getActiveToken(shopperId),
    log: rootLog.child({ component: "promptql" }),
  });
  const resolver = new ShopperResolver(shoppers, mappings, credentials);

  return {
    config,
    log: rootLog,
    db: database,
    shoppers,
    mappings,
    credentials,
    audit,
    outboundLog,
    workflows,
    chatBots,
    adapter,
    resolver,
  };
}
