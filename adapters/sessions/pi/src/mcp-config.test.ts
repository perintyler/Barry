import { describe, expect, it } from "vitest";
import { McpTransportRefused, toPiMcpConfig, toPiMcpConfigs } from "./mcp-config.js";

describe("Pi MCP Config Conversion", () => {
  it("converts stdio servers correctly", () => {
    const config = toPiMcpConfig("git", {
      type: "stdio",
      command: "mcp-server-git",
      args: ["--repository", "."],
      env: { GIT_TRACE: "1" },
    });

    expect(config).toEqual({
      type: "stdio",
      command: "mcp-server-git",
      args: ["--repository", "."],
      env: { GIT_TRACE: "1" },
    });
  });

  it("converts http servers correctly", () => {
    const config = toPiMcpConfig("remote", {
      type: "http",
      url: "https://mcp.internal/api",
      headers: { Authorization: "Bearer test" },
    });

    expect(config).toEqual({
      type: "http",
      url: "https://mcp.internal/api",
      headers: { Authorization: "Bearer test" },
    });
  });

  it("refuses legacy SSE servers outright", () => {
    expect(() =>
      toPiMcpConfig("legacy", {
        type: "sse",
        url: "https://mcp.internal/sse",
      }),
    ).toThrow(McpTransportRefused);
  });

  it("converts multiple servers in a map", () => {
    const configs = toPiMcpConfigs({
      s1: { command: "node", args: ["server.js"] },
      s2: { type: "http", url: "https://example.com" },
    });

    expect(configs.s1.type).toBe("stdio");
    expect(configs.s2.type).toBe("http");
  });
});
