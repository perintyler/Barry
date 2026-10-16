import { expect, it, vi } from "vitest";
import { guestSessionMcpConfig } from "./session-mcp-config.js";

vi.mock("../mcp-config.js", () => ({ generateMcpConfig: () => ({ mcpServers: { barry: { type: "http", url: "http://127.0.0.1:4807/mcp" } } }) }));
vi.mock("@barry-rocks/sdk/bags", () => ({ ALWAYS_ON_MCP_SERVERS: ["barry"] }));
vi.mock("@barry-rocks/sdk/internal/sessions", () => ({
  resolveSessionNamespaces: async (_id: string, options: { fallback: string[] }) => options.fallback,
}));

it("retains namespace endpoints and tool prefixes when discovery falls back", async () => {
  const config = await guestSessionMcpConfig(["git", "bash"], "draft");
  expect(Object.keys(config.mcpServers)).toEqual(["barry", "git", "bash"]);
  expect(config.mcpServers.git).toMatchObject({ url: "http://127.0.0.1:4807/mcp/ns/git?sessionId=draft" });
  expect(config.mcpServers.bash).toMatchObject({ url: "http://127.0.0.1:4807/mcp/ns/bash?sessionId=draft" });
  expect(config.mcpServers.barry).toMatchObject({ url: "http://127.0.0.1:4807/mcp?sessionId=draft&split=git%2Cbash" });
});
