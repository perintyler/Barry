import { parseBounds } from "../../identities/entries.js";
/**
 * Conformance tests for what Barry ships: the builtin directory, and what the
 * base identity beside it packs, grants and defines.
 *
 * These exist because both failure modes here are silent at runtime: a bag that
 * is not discovered simply is not there, and a trait granting a namespace no
 * bag provides is never reported — filterTools iterates tools and looks up
 * their namespace, so an unmatched grant just yields fewer tools.
 *
 * Note the other tests in this directory deliberately point BARRY_BUILTIN_DIR
 * at a nonexistent directory to isolate themselves from the real tree. This
 * file is the opposite: it asserts on the real one.
 */

import { describe, it, expect } from "vitest";
import { isBuiltinBag, loadBuiltinRegistry } from "../registry.js";
import { baseIdentitySelection, builtinBagsDir, discoverBuiltinBags } from "../builtin.js";
import { parseManifest, registeredName } from "../manifest.js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const BAGS_DIR = join(REPO_ROOT, "bags");

/** Run `fn` against the real tree, with no test override in effect. */
function withRealTree<T>(fn: () => T): T {
  const builtin = process.env.BARRY_BUILTIN_DIR;
  delete process.env.BARRY_BUILTIN_DIR;
  try {
    loadBuiltinRegistry(); // re-prime the cache off the real tree
    return fn();
  } finally {
    if (builtin === undefined) delete process.env.BARRY_BUILTIN_DIR;
    else process.env.BARRY_BUILTIN_DIR = builtin;
  }
}

const shipped = () => discoverBuiltinBags(BAGS_DIR);

describe("the builtin directory", () => {
  it("locates itself at the repository's bags/", () => {
    expect(withRealTree(() => builtinBagsDir())).toBe(resolve(BAGS_DIR));
  });

  it("discovers the bags that ship, nested ones included", () => {
    const { local } = shipped();
    // Guard the guard: an empty discovery would make every assertion below
    // vacuous and still pass.
    expect(Object.keys(local).length).toBeGreaterThan(10);
    // Nested bags are why the old registry needed a hand-written line each.
    // Discovery must find them without one.
    expect(local.locks).toBe(join("filesystem", "locks"));
    expect(local.logs).toBe(join("telemetry", "logs"));
    expect(local["sessions/search"]).toBe(join("sessions", "extensions", "search"));
  });

  it("every explicit registration has its declared manifest", () => {
    const registrations = shipped().local;
    expect(Object.keys(registrations).length).toBeGreaterThan(0);
    for (const [name, path] of Object.entries(registrations)) {
      expect(registeredName(parseManifest(join(BAGS_DIR, path))!)).toBe(name);
    }
  });

  it("packs search as an extension instead of composing it", () => {
    expect(parseManifest(join(BAGS_DIR, "sessions"))?.bags).not.toContain("sessions-search");
    expect(parseManifest(join(BAGS_DIR, "sessions"))?.bags).not.toContain("sessions/search");
    expect(baseIdentitySelection(BAGS_DIR).bags).toContain("sessions/search");
  });

  it("every shipped bag's manifest parses", () => {
    // An invalid bag.yaml does not fail loudly: the loader warns and the bag
    // loads as a husk with no tools, traits or schedules — indistinguishable
    // from one that declares none. A merge once left a job-shaped entry under
    // services' `schedules:`, and nothing noticed.
    const invalid: string[] = [];
    for (const [name, rel] of Object.entries(shipped().local)) {
      try {
        parseManifest(join(BAGS_DIR, rel));
      } catch (error) {
        invalid.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(invalid, `shipped bags with invalid manifests:\n  ${invalid.join("\n  ")}`).toEqual([]);
  });

});

describe("the base identity", () => {
  const base = () => baseIdentitySelection(BAGS_DIR);

  it("packs only bags that ship", () => {
    const { local } = shipped();
    const missing = base().bags.filter((name) => !(name in local));
    expect(base().bags.length, "the base identity packs nothing — this test would assert nothing").toBeGreaterThan(0);
    expect(missing, `the base identity packs bags that do not ship: ${missing.join(", ")}`).toEqual([]);
  });

  it("grants only the traits of bags that ship", () => {
    // Every default is a builtin bag's own trait, named after the bag. A
    // default naming anything else grants nothing and says nothing.
    const { local } = shipped();
    const dangling = base().traits.filter((name) => !(name in local));
    expect(base().traits.length).toBeGreaterThan(0);
    expect(dangling, `default traits no shipped bag defines: ${dangling.join(", ")}`).toEqual([]);
  });

  it("defines the bounds Barry ships, and readonly denies writes", () => {
    // `barry start --read` prints "read-only". This is what makes that true.
    const bounds = Object.fromEntries(parseBounds(parseYaml(readFileSync(join(dirname(shipped().dir!), "identity.yaml"), "utf8")).bounds).map(entry => [entry.name, entry]));
    expect(Object.keys(bounds).sort()).toEqual(["no-network", "no-network-write", "no-secrets", "readonly", "sandboxed-offline"]);
    expect(bounds.readonly?.bound.deniedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit"]));
    expect(bounds.readonly?.bound.deniedAccess).toContain("write");
  });
});

/**
 * Builtin DETECTION over the real tree.
 *
 * The other `isBuiltinBag` tests build fixtures, and a fixture once recreated an
 * old layout — so it kept passing after the registry moved while the real
 * predicate recognised nothing. These assert against what Barry actually ships,
 * which is the only layout a fixture cannot hold still.
 */
describe("builtin detection over the real tree", () => {
  it("recognises every shipped bag as builtin", () => {
    const expected = Object.keys(shipped().local);
    expect(expected.length).toBeGreaterThan(10);
    const missed = withRealTree(() => expected.filter((n) => !isBuiltinBag(n)));
    expect(missed, `not detected as builtin: ${missed.join(", ")}`).toEqual([]);
  });

  it("does not count the base identity, or a bag that does not ship, as builtin", () => {
    // Without this the test above would pass for a predicate that simply
    // returned true. `barry` is the base identity, not a bag.
    const notBags = ["barry", "notion-official"];
    expect(notBags.length).toBeGreaterThan(1);
    const wrong = withRealTree(() => notBags.filter((n) => isBuiltinBag(n)));
    expect(wrong, `wrongly counted as builtin: ${wrong.join(", ")}`).toEqual([]);
  });

  it("the registry fallback carries every builtin at its absolute path", () => {
    const registry = withRealTree(() => loadBuiltinRegistry());
    expect(registry["notion-official"]).toBeUndefined();
    expect(registry.actions).toEqual({ type: "local", path: join(resolve(BAGS_DIR), "actions") });
  });
});
