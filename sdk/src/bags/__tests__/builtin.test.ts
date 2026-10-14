import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { baseIdentitySelection, discoverBuiltinBags, resolveBuiltinPath } from "../builtin.js";

let dir: string;

function bag(rel: string, manifest: string): void {
  mkdirSync(join(dir, rel), { recursive: true });
  writeFileSync(join(dir, rel, "bag.yaml"), manifest);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "builtin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("builtin registration by directory", () => {
  // `dir` is the bags/ folder; the base identity sits beside it.
  let bags: string;
  beforeEach(() => {
    bags = join(dir, "bags");
    mkdirSync(bags);
  });
  function inBags(rel: string, manifest: string): void {
    mkdirSync(join(bags, rel), { recursive: true });
    writeFileSync(join(bags, rel, "bag.yaml"), manifest);
  }

  it("registers every folder with a bag.yaml, including nested bags, by its manifest's name", () => {
    inBags("alpha", "name: alpha\ndescription: a\n");
    inBags("outer", "name: outer\ndescription: o\n");
    inBags("outer/extensions/inner", "name: inner\nextends: outer\ndescription: nested\n");
    expect(discoverBuiltinBags(bags).local).toEqual({ alpha: "alpha", outer: "outer", "outer/inner": join("outer", "extensions", "inner") });
  });

  it.each([
    ["outer/extensions/inner", "name: inner\ndescription: nested\n"],
    ["outer/extensions/inner", "name: inner\nextends: other\ndescription: nested\n"],
    ["inner", "name: inner\nextends: outer\ndescription: nested\n"],
    ["outer/extensions/wrong", "name: inner\nextends: outer\ndescription: nested\n"],
  ])("refuses an extension location mismatch at %s", (path, manifest) => {
    inBags("outer", "name: outer\ndescription: o\n");
    inBags(path, manifest);
    expect(() => discoverBuiltinBags(bags)).toThrow(/extensions/);
  });

  it("never enters dependencies, build output, or test fixtures", () => {
    inBags("alpha", "name: alpha\ndescription: a\n");
    inBags("alpha/node_modules/dep", "name: dep\ndescription: d\n");
    inBags("alpha/dist", "name: built\ndescription: b\n");
    inBags("alpha/src/__tests__/fixture", "name: fixture\ndescription: f\n");
    expect(discoverBuiltinBags(bags).local).toEqual({ alpha: "alpha" });
  });

  it("refuses two folders declaring one name", () => {
    inBags("one", "name: same\ndescription: a\n");
    inBags("two", "name: same\ndescription: b\n");
    expect(() => discoverBuiltinBags(bags)).toThrow(/declared twice/);
  });

  it("supports opting out with an absent directory", () => {
    expect(discoverBuiltinBags(null)).toEqual({ dir: null, local: {} });
  });
});

describe("baseIdentitySelection", () => {
  it("reads the base identity's bags and traits, by name, beside bags/", () => {
    const bags = join(dir, "bags");
    mkdirSync(bags);
    writeFileSync(join(dir, "identity.yaml"), "name: barry\nbags: [actions, sessions]\ntraits:\n  - bash\n  - review: { optional: true }\n");
    expect(baseIdentitySelection(bags)).toEqual({ bags: ["actions", "sessions"], traits: ["bash"] });
  });

  it("includes the base identity's extensions", () => {
    const bags = join(dir, "bags");
    mkdirSync(bags);
    writeFileSync(join(dir, "identity.yaml"), "bags:\n  - sessions: { extensions: [search] }\n");
    expect(baseIdentitySelection(bags).bags).toEqual(["sessions", "sessions/search"]);
  });

  it("is empty without a builtin directory", () => {
    expect(baseIdentitySelection(null)).toEqual({ bags: [], traits: [] });
  });
});

describe("resolveBuiltinPath", () => {
  it("anchors a stored relative path on the builtin directory", () => {
    expect(resolveBuiltinPath("filesystem/locks", "/repo/bags")).toBe("/repo/bags/filesystem/locks");
  });

  it.each(["../../../harness/actions", "../../../bags/filesystem/tracker", "../outside"])("rejects retired or escaping registry path %s", (stored) => {
    expect(() => resolveBuiltinPath(stored, "/repo/bags")).toThrow("re-seed the bag registry explicitly");
  });

  it("leaves absolute and home-relative paths alone", () => {
    expect(resolveBuiltinPath("/elsewhere/bag", "/repo/bags")).toBe("/elsewhere/bag");
    expect(resolveBuiltinPath("~/repos/bags/x", "/repo/bags")).toBe("~/repos/bags/x");
  });

  it("returns the stored value when there is no builtin directory", () => {
    expect(resolveBuiltinPath("actions", null)).toBe("actions");
  });
});

/**
 * A fresh copy of the module per test: the "warned once" latches are module
 * state, and a latch tripped by one test would silence the next.
 */
async function freshBuiltin() {
  vi.resetModules();
  return import("../builtin.js");
}

describe("BARRY_BUILTIN_DIR", () => {
  let saved: string | undefined;
  let stderr: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    saved = process.env.BARRY_BUILTIN_DIR;
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    if (saved === undefined) delete process.env.BARRY_BUILTIN_DIR;
    else process.env.BARRY_BUILTIN_DIR = saved;
  });
  const warnings = () => stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  it("is loud when set to a directory that does not exist, and names the fix", async () => {
    // The failure this guards: bundles pinned to a directory that later moved
    // detected zero builtin bags, and nothing said so.
    process.env.BARRY_BUILTIN_DIR = join(dir, "moved-away");
    const { builtinBagsDir, discoverBuiltinBags } = await freshBuiltin();
    expect(discoverBuiltinBags().local).toEqual({});
    expect(builtinBagsDir()).toBe(join(dir, "moved-away"));
    expect(warnings()).toContain("does not exist");
    expect(warnings()).toContain("barry bag build --force");
  });

  it("warns once per process, not once per read", async () => {
    process.env.BARRY_BUILTIN_DIR = join(dir, "moved-away");
    const { builtinBagsDir } = await freshBuiltin();
    builtinBagsDir();
    builtinBagsDir();
    builtinBagsDir();
    expect(stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes("does not exist"))).toHaveLength(1);
  });

  it("is quiet for an existing empty directory, which is how a caller asks for no builtins", async () => {
    process.env.BARRY_BUILTIN_DIR = dir;
    const { discoverBuiltinBags } = await freshBuiltin();
    expect(discoverBuiltinBags().local).toEqual({});
    expect(warnings()).toBe("");
  });

  it("shareBuiltinDirWithBundles hands an unset variable the running checkout's directory", async () => {
    delete process.env.BARRY_BUILTIN_DIR;
    const { shareBuiltinDirWithBundles, BUILTIN_DIRNAME } = await freshBuiltin();
    shareBuiltinDirWithBundles();
    // A bundle's `||=` pin now finds the variable set and leaves it alone.
    expect(process.env.BARRY_BUILTIN_DIR).toMatch(new RegExp(`/${BUILTIN_DIRNAME}$`));
  });
});
