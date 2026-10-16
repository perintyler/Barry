import { describe, it, expect, vi } from "vitest";
import { Barry } from "@barry-rocks/sdk";
import { z } from "zod";
import { runMcpAction } from "./mcp-action.js";
import type { ScheduleAccess } from "./permissions.js";

vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  installationRegistry: () => ({ id: "node-local" }),
}));

describe("runMcpAction", () => {
  const readTool = Barry.Tool({
    namespace: "docs",
    name: "read_doc",
    access: "read",
    description: "Read doc",
    schema: { path: z.string() },
    handler: async ({ path }) => ({ content: `read:${path}` }),
  });

  const writeTool = Barry.Tool({
    namespace: "docs",
    name: "write_doc",
    access: "write",
    description: "Write doc",
    schema: { path: z.string() },
    handler: async ({ path }) => ({ written: path }),
  });

  const docsBag = {
    name: "docs",
    tools: [readTool, writeTool],
  };

  it("invokes a tool resolved via Barry.tools and enforces read-twin and file bounds", async () => {
    const readBound = Barry.bound(null, [{ tools: { deny: ["docs:write"] }, files: { deny: ["/secret/**"] } }]);
    const tools = Barry.tools(null, [docsBag], readBound);
    const access: ScheduleAccess = {
      bags: ["docs"],
      bound: readBound,
      tools,
      allowedToolIds: tools.map((t) => `${t.namespace}:${t.name}`),
    };

    const ok = await runMcpAction("docs:read_doc", { path: "/safe/guide.md" }, access);
    expect(ok).toEqual({ content: "read:/safe/guide.md" });

    await expect(
      runMcpAction("docs:read_doc", { path: "/secret/keys.txt" }, access),
    ).rejects.toThrow(/Access denied: path matches deny pattern/);

    await expect(
      runMcpAction("docs:write_doc", { path: "/safe/guide.md" }, access),
    ).rejects.toThrow(/tool access denied/);
  });

  it("refuses execution when bound.nodes excludes the local node", async () => {
    const nodeBound = Barry.bound(null, [{ nodes: { allow: ["node-remote"] } }]);
    const tools = Barry.tools(null, [docsBag], nodeBound);
    const access: ScheduleAccess = {
      bags: ["docs"],
      bound: nodeBound,
      tools,
      allowedToolIds: tools.map((t) => `${t.namespace}:${t.name}`),
    };

    await expect(
      runMcpAction("docs:read_doc", { path: "/safe/guide.md" }, access),
    ).rejects.toThrow(/node-local/);
  });
});
