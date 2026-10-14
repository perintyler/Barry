import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeAntigravityWorkspace } from "./workspace.js";
import { createInstrumentedHooks, setupTrackingHooks } from "./hooks.js";
const config = { sessionId: "persistent-workspace", cwd: "/tmp", env: {}, mcpServers: {} };
it("keeps conversation data while rewriting configuration and hooks", () => {
  const { workspaceDir: home } = writeAntigravityWorkspace(config);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, ".gemini", "antigravity-cli")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, ".gemini", "antigravity-cli", "settings.json")).mode & 0o777).toBe(0o600);
  const brain = join(home, ".gemini", "antigravity-cli", "brain");
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, "kept"), "conversation");
  setupTrackingHooks(home, "tracking-relay");
  createInstrumentedHooks().setup(home);
  expect(JSON.parse(readFileSync(join(home, ".agents", "hooks.json"), "utf8"))).toHaveProperty("barry-inbox");
  expect(writeAntigravityWorkspace(config).workspaceDir).toBe(home);
  expect(readFileSync(join(brain, "kept"), "utf8")).toBe("conversation");
  expect(Object.keys(JSON.parse(readFileSync(join(home, ".agents", "hooks.json"), "utf8")))).toEqual(["barry-gating"]);
});
it("keeps the MCP configuration, which carries a bearer token, private to its owner", () => {
  const withToken = { ...config, sessionId: "private-mcp-config", mcpServers: { barry: { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer secret" } } } };
  const mcpConfig = join(writeAntigravityWorkspace(withToken).workspaceDir, ".agents", "mcp_config.json");
  expect(statSync(mcpConfig).mode & 0o777).toBe(0o600);
  chmodSync(mcpConfig, 0o644);
  writeAntigravityWorkspace(withToken);
  expect(statSync(mcpConfig).mode & 0o777).toBe(0o600);
});
