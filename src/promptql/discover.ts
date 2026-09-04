/**
 * MCP discovery diagnostic. Initializes an MCP session against the configured
 * PromptQL project and prints the available tool names + JSON Schemas so the
 * real submit/poll tool contract can be verified BEFORE the first milestone is
 * marked complete.
 *
 * Run:  bun run mcp:discover
 * Token source (in order):
 *   1) MCP_DISCOVER_TOKEN env var
 *   2) first CLI arg
 * The token is used only to authenticate this one call. It is NEVER printed.
 */

import { loadConfig } from "../config.ts";
import { McpSession } from "./mcpClient.ts";
import { maskSecret } from "../util.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.mcp.endpoint) {
    console.error("PROMPTQL_PROJECT_URL is not set. Configure it in .env first.");
    process.exit(2);
  }

  const token =
    process.env.MCP_DISCOVER_TOKEN ?? process.env.PROMPTQL_MCP_TEST_PAT ?? process.argv[2];
  if (!token) {
    console.error(
      "No token. Provide an MCP-scoped service-account token via MCP_DISCOVER_TOKEN or as the first arg.",
    );
    process.exit(2);
  }

  console.log(`[discover] endpoint : ${config.mcp.endpoint}`);
  console.log(`[discover] scheme   : ${config.mcp.authScheme}`);
  console.log(`[discover] token    : ${maskSecret(token)} (masked)`);
  console.log(`[discover] protocol : ${config.mcp.protocolVersion}`);

  const session = new McpSession(
    {
      endpoint: config.mcp.endpoint,
      authScheme: config.mcp.authScheme,
      protocolVersion: config.mcp.protocolVersion,
      timeoutMs: config.mcp.timeoutMs,
      maxRetries: config.mcp.maxRetries,
    },
    token,
  );

  const tools = await session.listTools();
  console.log(`\n[discover] ${tools.length} tool(s) found:\n`);
  for (const t of tools) {
    console.log(`- ${t.name}`);
    if (t.description) console.log(`    ${t.description}`);
    if (t.inputSchema) {
      const schema = JSON.stringify(t.inputSchema, null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      console.log(`  inputSchema:\n${schema}`);
    }
  }
  console.log(
    "\nThe gateway uses the verified thread/bot flow: ask_promptql ->",
  );
  console.log("get_latest_promptql_thread_response (see src/promptql/promptqlAdapter.ts).");
  console.log("If the tool names/schemas above differ, update the adapter to match.");
}

main().catch((err) => {
  console.error(`[discover] failed: ${String(err)}`);
  process.exit(1);
});
