import { describe, it, expect } from "vitest";
import { checkBagRequirements, packedBagsRequiring } from "../requirement-check.js";
import { parseManifestObject } from "../manifest.js";
import type { Bag, BagRequirement } from "../types.js";

function makeBag(requires: Array<BagRequirement & { target: string }>): Bag {
  return {
    name: "consumer",
    description: "",
    builtin: false,
    source: { type: "local", path: "/b/consumer" },
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
    requires,
    services: [],
    apps: [],
    schedules: [],
  };
}

const AVAILABLE = { isBagAvailable: () => true };
const UNAVAILABLE = { isBagAvailable: () => false };

describe("checkBagRequirements", () => {
  it("passes when the target bag is available and no resource is named", () => {
    const bag = makeBag([{ target: "session" }]);
    expect(checkBagRequirements(bag, AVAILABLE)).toEqual([]);
  });

  it("fails fast naming bag, target, and reason when the bag is missing", () => {
    const bag = makeBag([{ target: "session", reason: "appends transcripts" }]);
    const missing = checkBagRequirements(bag, UNAVAILABLE);
    expect(missing).toHaveLength(1);
    expect(missing[0].bag).toBe("consumer");
    expect(missing[0].target).toBe("session");
    expect(missing[0].optional).toBe(false);
    expect(missing[0].message).toContain("consumer requires session");
    expect(missing[0].message).toContain("appends transcripts");
  });

  it("treats a resource declaration as satisfied when the bag itself is available", () => {
    // Resource checking is gone with the bag-resource env source: a
    // requirement is about the bag's presence, not about a registry entry.
    const bag = makeBag([{ target: "session", resource: "store" }]);
    expect(checkBagRequirements(bag, AVAILABLE)).toEqual([]);
  });

  it("marks optional requirements so callers can warn instead of dropping", () => {
    const bag = makeBag([{ target: "linear", optional: true }]);
    const missing = checkBagRequirements(bag, UNAVAILABLE);
    expect(missing).toHaveLength(1);
    expect(missing[0].optional).toBe(true);
  });

  it("returns [] for a bag with no requirements without touching the registry", () => {
    const bag = makeBag([]);
    expect(checkBagRequirements(bag, {
      isBagAvailable: () => { throw new Error("must not be called"); },
    })).toEqual([]);
  });
});

describe("manifest requires parsing", () => {
  const base = { name: "t", description: "d" };

  it("parses and normalizes allow-remote", () => {
    const m = parseManifestObject({
      ...base,
      requires: { session: { resource: "store", reason: "r", optional: true, "allow-remote": true } },
    });
    expect(m.requires).toEqual({
      session: { resource: "store", reason: "r", optional: true, allowRemote: true },
    });
  });

  it("rejects unknown requirement keys (strict schema)", () => {
    expect(() => parseManifestObject({ ...base, requires: { session: { port: 3000 } } })).toThrow();
  });
});

describe("packedBagsRequiring", () => {
  const bag = (name: string, requires?: Record<string, BagRequirement>) => ({ name, manifest: { requires } });

  it("names the packed bags whose non-optional requirement the target meets", () => {
    const packed = [bag("mcp", { identities: {}, sessions: {} }), bag("github", { identities: { optional: true } }), bag("identities")];
    expect(packedBagsRequiring("identities", packed)).toEqual(["mcp"]);
    expect(packedBagsRequiring("sessions", packed)).toEqual(["mcp"]);
  });

  it("names nothing for a bag nobody requires", () => {
    expect(packedBagsRequiring("memory", [bag("mcp", { identities: {} })])).toEqual([]);
  });
});
