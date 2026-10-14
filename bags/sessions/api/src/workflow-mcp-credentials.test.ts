import { describe, expect, it } from "vitest";
import { withWorkflowSessionCredential } from "./workflow-mcp-credentials.js";
import { getServicePort } from "@barry-rocks/sdk/services";

describe("workflow session MCP credential routing", () => {
  it("replaces only Barry's local aggregate and namespace gateway credentials", () => {
    const port = getServicePort("mcpBarry");
    const servers = {
      barry: { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer installation-secret", "X-Other": "keep" } },
      documents: { type: "http" as const, url: `http://127.0.0.1:${port}/mcp/ns/documents`, headers: { authorization: "old" } },
      remote: { type: "http" as const, url: "https://remote.example/mcp", headers: { Authorization: "remote-secret" } },
      unrelated: { type: "http" as const, url: `http://127.0.0.1:${port + 1}/mcp` },
      stdio: { type: "stdio" as const, command: "fixture", args: [] },
    };
    const result = withWorkflowSessionCredential(servers, "bws3.fixture");
    expect(result.barry).toMatchObject({ headers: { Authorization: "Bearer bws3.fixture", "X-Other": "keep" } });
    expect(result.documents).toMatchObject({ headers: { Authorization: "Bearer bws3.fixture" } });
    expect(result.remote).toEqual(servers.remote);
    expect(result.unrelated).toEqual(servers.unrelated);
    expect(result.stdio).toEqual(servers.stdio);
    expect(servers.barry.headers.Authorization).toBe("Bearer installation-secret");
  });

  it("refuses to launch a workflow session without a Barry-scoped gateway", () => {
    expect(() => withWorkflowSessionCredential({ remote: { type: "http", url: "https://remote.example/mcp" } }, "token")).toThrow("no scoped Barry MCP gateway");
  });
});
