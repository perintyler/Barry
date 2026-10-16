import { describe, it, expect } from "vitest";
import { mergeBags, mergeBagMcpServers } from "../merge.js";
import type { Bag } from "../types.js";

function makeBag(overrides: Partial<Bag>): Bag {
  return {
    name: "test",
    description: "test bag",
    builtin: false,
    source: { type: "local", path: "/test" },
    manifest: null,
    skillsDirs: [],
    actionsDirs: [],
    instructionsDirs: [],
    mcpServers: {},
    tools: [],
    dependencies: [],
    slashCommands: [],
    hooks: [],
    requires: [],
    services: [],
    apps: [],
    schedules: [],
    ...overrides,
  };
}

describe("merge", () => {
  it("merges MCP servers from multiple bags", () => {
    const bag1 = makeBag({ name: "a", mcpServers: { sentry: { url: "http://sentry" } } });
    const bag2 = makeBag({ name: "b", mcpServers: { linear: { url: "http://linear" } } });

    const merged = mergeBags([bag1, bag2]);
    expect(Object.keys(merged.mcpServers).sort()).toEqual(["linear", "sentry"]);
  });

  it("merges skill directories", () => {
    const bag1 = makeBag({ name: "a", skillsDirs: ["/a/skills"] });
    const bag2 = makeBag({ name: "b", skillsDirs: ["/b/skills"] });

    const merged = mergeBags([bag1, bag2]);
    expect(merged.skillsDirs).toEqual(["/a/skills", "/b/skills"]);
  });

  it("accumulates tool metadata from all bags", () => {
    const bag1 = makeBag({
      name: "a",
      tools: [{ toolName: "t1", namespace: "ns1", access: "read" }],
    });
    const bag2 = makeBag({
      name: "b",
      tools: [{ toolName: "t2", namespace: "ns2", access: "readwrite" }],
    });

    const merged = mergeBags([bag1, bag2]);
    expect(merged.tools).toHaveLength(2);
  });

  it("mergeBagMcpServers preserves existing config", () => {
    const bag = makeBag({ mcpServers: { linear: { url: "http://linear" } } });
    const existing = { barry: { type: "http" as const, url: "http://barry" } };

    const merged = mergeBagMcpServers([bag], existing);
    expect(merged.barry.url).toBe("http://barry");
    expect(merged.linear.url).toBe("http://linear");
  });
});
