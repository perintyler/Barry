/**
 * Locks must stay opt-in, and there are two ways that quietly stops being true.
 *
 * The `locks` tools live in the `locks` bag namespace. A session gets them only
 * by selecting the `locks` bag — not from the default session bags.
 *
 * Both failure modes are silent: the tools simply appear in sessions that never
 * asked for them, and nothing errors. So both are asserted here.
 *
 *   1. RESTAMPING — if the locks tools stamped `filesystem`, selecting the
 *      `filesystem` bag would expose them on every default session.
 *   2. COMPOSITION — `expandComposition` folds every required sub-bag into
 *      the parent bag transitively. Listing `locks` under bags/filesystem's
 *      `bags:` would make `filesystem` include `locks`, reaching the
 *      same place by a different road.
 *
 * Verified by breaking each in turn and confirming this file goes red.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { baseIdentitySelection } from "../builtin.js";

function repoRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${import.meta.dirname}`);
    dir = parent;
  }
}

const root = repoRoot();
const manifest = (p: string) => parseYaml(readFileSync(join(root, p), "utf-8")) ?? {};

describe("the locks gate", () => {
  it("locks tools stamp their own namespace, not filesystem", () => {
    const src = readFileSync(join(root, "bags/filesystem/locks/src/tools.ts"), "utf-8");
    const stamped = [...src.matchAll(/namespace:\s*"([^"]+)"/g)].map((m) => m[1]);

    // Anti-tautology: if the file stopped defining tools, an empty set would
    // satisfy "none of them stamp filesystem" for the wrong reason.
    expect(stamped.length, "no namespaces parsed — did locks/src/tools.ts change shape?")
      .toBeGreaterThan(0);
    expect([...new Set(stamped)]).toEqual(["locks"]);
  });

  it("the filesystem bag does not compose locks", () => {
    const fsBag = manifest("bags/filesystem/bag.yaml");
    const composed: string[] = Array.isArray(fsBag.bags) ? fsBag.bags : Object.keys(fsBag.bags ?? {});

    // Composing SOMETHING is expected (tracker), so an empty list would mean
    // the manifest changed shape rather than that locks is safely excluded.
    expect(composed.length, "bags/filesystem composes nothing — did the manifest change shape?")
      .toBeGreaterThan(0);
    expect(
      composed,
      "bags/filesystem must not compose locks: expandComposition would fold the " +
        "locks bag into the filesystem bag, which every default session selects",
    ).not.toContain("locks");
  });

  it("no default bag composes the locks bag", () => {
    const defaults = baseIdentitySelection(join(root, "bags")).bags;
    expect(defaults.length).toBeGreaterThan(0);
    const resolved = defaults.map((name) => {
      const bagPath = join(root, "bags", name, "bag.yaml");
      if (!existsSync(bagPath)) return null;
      const bag = manifest(`bags/${name}/bag.yaml`);
      const composes = Array.isArray(bag.bags) ? bag.bags : Object.keys(bag.bags ?? {});
      return { name, composes };
    }).filter((entry): entry is { name: string; composes: string[] } => entry !== null);

    expect(
      resolved.length,
      "no default bag resolves to a builtin bag — did the default set change shape?",
    ).toBe(defaults.length);

    for (const { name, composes } of resolved) {
      expect(composes, `default bag "${name}" must not compose locks`).not.toContain("locks");
    }
  });
});
