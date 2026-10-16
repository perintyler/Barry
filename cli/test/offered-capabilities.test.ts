import { describe, it, expect } from "vitest";
import { buildSessionPickerCandidates, offeredCapabilities } from "../src/commands/start.js";
import type { Bag } from "@barry-rocks/sdk/bags";

/**
 * What the capability picker offers.
 *
 * The hide path is the feature; the REVEAL path (`--show-builtin`) is one
 * boolean away from it, and nothing else covers it. Inverting that boolean
 * silently would either bury the user's own bags under Barry's plumbing again,
 * or — worse — hide the bags they installed. Both are quiet failures: the
 * picker still renders, just with the wrong contents.
 */

const BUILTINS = new Set(["git", "keychain", "sessions"]);
const isBuiltin = (bag: string) => BUILTINS.has(bag);

const bagEntry = (name: string, description: string | null = `${name} desc`, tools: string[] = []) => ({
  name,
  description,
  tools,
});

const BAGS = [
  bagEntry("git"),
  bagEntry("keychain"),
  bagEntry("sessions"),
  bagEntry("linear"),
  bagEntry("scout"),
];

describe("offeredCapabilities", () => {
  it("hides builtin bags by default", () => {
    const o = offeredCapabilities(BAGS, false, isBuiltin);
    expect(o.bags.map((b) => b.name).sort()).toEqual(["linear", "scout"]);
    expect(o.hiddenBagCount).toBe(3);
  });

  it("offers every bag under --show-builtin", () => {
    const o = offeredCapabilities(BAGS, true, isBuiltin);
    expect(o.bags.map((b) => b.name).sort()).toEqual([
      "git", "keychain", "linear", "scout", "sessions",
    ]);
    expect(o.hiddenBagCount).toBe(0);
  });

  // A user bag must never be hidden. This is the failure that would be worst
  // in practice and quietest to spot.
  it("never hides a bag that is not builtin", () => {
    const o = offeredCapabilities(BAGS, false, isBuiltin);
    expect(o.bags.map((b) => b.name)).toContain("linear");
    expect(o.bags.map((b) => b.name)).toContain("scout");
  });

  // The description is what the user reads in the list; falling back to the
  // tool names keeps a description-less bag from rendering as a bare word.
  it("falls back to tool names when a bag has no description", () => {
    const undescribed = [{ name: "solo", description: null, tools: ["a", "b"] }];
    const o = offeredCapabilities(undescribed, false, isBuiltin);
    expect(o.bags[0].description).toBe("a, b");
  });

  // A restricted entry must not look identical to an unrestricted one.
  it("carries a hint for an entry with named bounds", () => {
    const scoped = [
      { name: "vc-read", description: "read-only", tools: [], boundNames: ["readonly"] },
    ];
    const o = offeredCapabilities(scoped, false, isBuiltin);
    expect(o.bags[0].boundHint).toBe("readonly");
  });

  it("carries a hint for an entry with an inline bound", () => {
    const inline = [
      { name: "coding", description: "code", tools: [], bound: { bash: { deny: ["git"] } } },
    ];
    const o = offeredCapabilities(inline, false, isBuiltin);
    expect(o.bags[0].boundHint).toBe("bounded");
  });

  it("leaves the hint off an entry that restricts nothing", () => {
    const o = offeredCapabilities(BAGS, true, isBuiltin);
    expect(o.bags.every((b) => b.boundHint === undefined)).toBe(true);
  });

  it("leaves the hint off for an empty inline bound", () => {
    const empty = [
      { name: "plain", description: "d", tools: [], bound: {}, boundNames: [] },
    ];
    const o = offeredCapabilities(empty, false, isBuiltin);
    expect(o.bags[0].boundHint).toBeUndefined();
  });
});

describe("buildSessionPickerCandidates", () => {
  const mockBag = (name: string, bounds: Record<string, { description?: string; bound: Record<string, unknown> }> = {}): Bag =>
    ({
      name,
      description: `${name} description`,
      builtin: isBuiltin(name),
      source: { type: "local", path: `/bags/${name}` },
      manifest: {
        name,
        description: `${name} description`,
        bounds,
        mcpServers: {},
        tools: [],
        dependencies: [],
        services: {},
        apps: {},
        schedules: {},
      },
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
      jobs: [],
    }) as unknown as Bag;

  it("excludes required identity bags, marks optional identity bags, and filters bag bounds by Step 1 active bags", () => {
    const candidates = buildSessionPickerCandidates({
      requiredBags: ["sessions", "coding"],
      optionalBags: ["linear"],
      installedBags: [
        mockBag("sessions"),
        mockBag("coding", { ic: { description: "IC mode", bound: { bash: { deny: ["git push*"] } } } }),
        mockBag("git", { "no-push": { description: "No push", bound: { bash: { deny: ["git push*"] } } } }),
        mockBag("linear", { triage: { description: "Triage only", bound: { tools: { deny: ["linear:write"] } } } }),
        mockBag("slack", { "self-dm": { description: "Self DM", bound: { tools: { deny: ["slack:write"] } } } }),
      ],
      requiredBounds: ["coding:ic"],
      optionalBounds: ["custom-guard"],
      globalBounds: [{ name: "readonly", tools: { deny: ["*:write"] } }],
      identityBounds: [
        { name: "coding:ic", bash: { deny: ["git push*"] } },
        { name: "custom-guard", network: { deny: ["write"] } },
      ],
      identityName: "bux",
      showBuiltin: false,
      isBuiltin,
    });

    // Step 1 excludes required bags ("sessions", "coding") and hides builtin "git" when showBuiltin is false.
    expect(candidates.bags.map((b) => b.name)).toEqual(["linear", "slack"]);
    expect(candidates.bags.find((b) => b.name === "linear")?.hint).toBe("optional on bux");
    expect(candidates.bags.find((b) => b.name === "slack")?.hint).toBeUndefined();
    expect(candidates.hiddenBagCount).toBe(1);

    // Step 2 when only ["linear"] is picked in Step 1:
    // - excludes required bound "coding:ic"
    // - includes global bound "readonly"
    // - includes optional identity bound "custom-guard" with hint
    // - includes "linear:triage" (since linear was picked in Step 1)
    // - excludes "slack:self-dm" (since slack was NOT picked in Step 1)
    // - excludes "git:no-push" (since git was NOT picked in Step 1)
    const boundsForLinear = candidates.resolveBounds(["linear"]);
    expect(boundsForLinear.map((b) => b.name)).toEqual(["readonly", "custom-guard", "linear:triage"]);
    expect(boundsForLinear.find((b) => b.name === "custom-guard")?.hint).toBe("optional on bux");
  });
});
