import { describe, it, expect } from "vitest";
import { mergeBags, getAllTraits, mergeBagMcpServers } from "../merge.js";
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
    traits: [],
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
  it("refuses a trait alias claimed by multiple bags", () => {
    const bag1 = makeBag({
      name: "a",
      traits: [{ name: "shared", description: "from a", access: "read", bags: ["ns1"], skills: [], instructions: [], boundNames: [] }],
      mcpServers: { ns1: { type: "http", url: "http://a" } },
    });
    const bag2 = makeBag({
      name: "b",
      traits: [{ name: "shared", description: "from b", access: "readwrite", bags: ["ns2"], skills: [], instructions: [], boundNames: [] }],
      mcpServers: { ns2: { type: "http", url: "http://b" } },
    });

    expect(() => mergeBags([bag1, bag2])).toThrow(/claimed by bags a and b/);
  });

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

  it("getAllTraits returns auto + custom traits", () => {
    const bag = makeBag({
      name: "mypack",
      mcpServers: { sentry: { url: "http://sentry" } },
      traits: [{ name: "custom", description: "custom", access: "read", bags: ["sentry"], skills: [], instructions: [], boundNames: [] }],
    });

    const traits = getAllTraits(bag);
    const names = traits.map(t => t.name).sort();
    // The readwrite auto-trait, its :read twin, and the custom trait.
    expect(names).toEqual(["custom", "mypack", "mypack:read"]);
  });

  it("getAllTraits lets a manifest trait override the same-named auto trait", () => {
    const bag = makeBag({
      name: "mypack",
      mcpServers: { sentry: { url: "http://sentry" } },
      traits: [
        {
          name: "mypack",
          description: "narrowed",
          access: "readwrite",
          bags: ["sentry"],
          skills: ["only-this-skill"], instructions: [], boundNames: [],
        },
      ],
    });

    const traits = getAllTraits(bag);
    expect(traits.map(t => t.name)).toEqual(["mypack", "mypack:read"]);

    // The manifest definition wins rather than appearing alongside the auto one.
    const rw = traits.filter(t => t.name === "mypack");
    expect(rw).toHaveLength(1);
    expect(rw[0].description).toBe("narrowed");
    expect(rw[0].skills).toEqual(["only-this-skill"]);
  });

  // A bag whose read-only variant must differ declares a `read` trait; the
  // manifest qualifies it to `mypack:read`, and it replaces the generated twin.
  it("getAllTraits lets a manifest `read` trait replace the generated twin", () => {
    const bag = makeBag({
      name: "mypack",
      mcpServers: { sentry: { url: "http://sentry" } },
      traits: [{ name: "mypack:read", description: "custom read", access: "read", bags: ["sentry"], skills: [], instructions: [], boundNames: [] }],
    });
    const twins = getAllTraits(bag).filter((t) => t.name === "mypack:read");
    expect(twins).toHaveLength(1);
    expect(twins[0].description).toBe("custom read");
  });

  it("mergeBagMcpServers preserves existing config", () => {
    const bag = makeBag({ mcpServers: { linear: { url: "http://linear" } } });
    const existing = { barry: { type: "http" as const, url: "http://barry" } };

    const merged = mergeBagMcpServers([bag], existing);
    expect(merged.barry.url).toBe("http://barry");
    expect(merged.linear.url).toBe("http://linear");
  });
});
