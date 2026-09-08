import { afterEach, expect, test } from "bun:test";
import { loadConfig, resetConfigForTests } from "../src/config.ts";
afterEach(resetConfigForTests);
const env = {
  GATEWAY_ADMIN_TOKEN: "test-admin-token-0123456789",
  DATA_ENCRYPTION_KEY: "00".repeat(32),
};
test("project_name remains optional for older scoped MCP endpoints", () => {
  resetConfigForTests();
  expect(loadConfig(env).mcp.projectName).toBeUndefined();
});
test("configured project_name is validated at the environment boundary", () => {
  resetConfigForTests();
  expect(loadConfig({ ...env, PROMPTQL_PROJECT_NAME: "sept" }).mcp.projectName).toBe("sept");
  resetConfigForTests();
  expect(() => loadConfig({ ...env, PROMPTQL_PROJECT_NAME: "" })).toThrow();
});
