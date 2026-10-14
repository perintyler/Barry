import { describe, it, expect } from "vitest";
import { resolveTraits } from "./resolve-traits.js";
import type { AgentTrait } from "./types.js";

const traits: Record<string, AgentTrait> = {
  core: {
    name: "core",
    namespaces: ["filesystem", "bash", "git", "task", "session"],
    access: "readwrite",
  },
  debug: {
    name: "debug",
    namespaces: ["sentry", "datadog"],
    access: "read",
  },
  "read-notion": {
    name: "read-notion",
    namespaces: ["notion"],
    access: "read",
  },
  "write-notion": {
    name: "write-notion",
    namespaces: ["notion"],
    access: "readwrite",
  },
  notion: {
    name: "notion",
    namespaces: [],
    access: "read",
    includes: ["read-notion", "write-notion"],
  },
  slack: {
    name: "slack",
    namespaces: ["slack"],
    access: "readwrite",
  },
};

describe("resolveTraits", () => {
  it("resolves single trait to namespace map", () => {
    const { byNamespace } = resolveTraits(["core"], traits);
    expect(byNamespace.get("filesystem")).toBe("readwrite");
    expect(byNamespace.get("bash")).toBe("readwrite");
    expect(byNamespace.get("git")).toBe("readwrite");
    expect(byNamespace.has("sentry")).toBe(false);
  });

  it("resolves multiple traits", () => {
    const { byNamespace } = resolveTraits(["core", "debug"], traits);
    expect(byNamespace.get("filesystem")).toBe("readwrite");
    expect(byNamespace.get("sentry")).toBe("read");
    expect(byNamespace.get("datadog")).toBe("read");
  });

  it("more permissive access wins", () => {
    const { byNamespace } = resolveTraits(["read-notion", "write-notion"], traits);
    expect(byNamespace.get("notion")).toBe("readwrite");
  });

  it("expands composite traits", () => {
    const { byNamespace } = resolveTraits(["notion"], traits);
    expect(byNamespace.get("notion")).toBe("readwrite");
  });

  it("returns empty maps for no traits", () => {
    const { byNamespace, byTool } = resolveTraits([], traits);
    expect(byNamespace.size).toBe(0);
    expect(byTool.size).toBe(0);
  });

  it("ignores unknown traits", () => {
    const { byNamespace, byTool } = resolveTraits(["nonexistent"], traits);
    expect(byNamespace.size).toBe(0);
    expect(byTool.size).toBe(0);
  });

  it("handles circular includes safely", () => {
    const circular: Record<string, AgentTrait> = {
      a: { name: "a", namespaces: ["ns-a"], access: "read", includes: ["b"] },
      b: { name: "b", namespaces: ["ns-b"], access: "read", includes: ["a"] },
    };
    expect(() => resolveTraits(["a"], circular)).toThrow(/cycle/);
  });

  it("resolves explicit tool grants into byToolLegacy (bare, legacy) and byTool (qualified)", () => {
    const withTools: Record<string, AgentTrait> = {
      "sentry-read": {
        name: "sentry-read",
        namespaces: [],
        tools: ["search_issues"],
        access: "read",
      },
      "sentry-qualified": {
        name: "sentry-qualified",
        namespaces: [],
        tools: ["sentry:resolve_issue"],
        access: "readwrite",
      },
    };
    const { byNamespace, byTool, byToolLegacy } = resolveTraits(["sentry-read", "sentry-qualified"], withTools);
    expect(byNamespace.size).toBe(0);
    // A bare name is legacy: it lands in byToolLegacy, not byTool.
    expect(byToolLegacy.get("search_issues")).toBe("read");
    expect(byTool.has("search_issues")).toBe(false);
    // A qualified id lands in byTool keyed on the full ns:tool.
    expect(byTool.get("sentry:resolve_issue")).toBe("readwrite");
  });

  it("most permissive tool grant wins across traits (bare)", () => {
    const mixed: Record<string, AgentTrait> = {
      a: { name: "a", namespaces: [], tools: ["do_thing"], access: "read" },
      b: { name: "b", namespaces: [], tools: ["do_thing"], access: "readwrite" },
    };
    const { byToolLegacy } = resolveTraits(["a", "b"], mixed);
    expect(byToolLegacy.get("do_thing")).toBe("readwrite");
  });

  it("most permissive tool grant wins across traits (qualified)", () => {
    const mixed: Record<string, AgentTrait> = {
      a: { name: "a", namespaces: [], tools: ["ns:do_thing"], access: "read" },
      b: { name: "b", namespaces: [], tools: ["ns:do_thing"], access: "readwrite" },
    };
    const { byTool } = resolveTraits(["a", "b"], mixed);
    expect(byTool.get("ns:do_thing")).toBe("readwrite");
  });
});
