import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildBags, discoverBuildableBags, isBagBuildStale, getBuiltBagEntry, pruneOrphanedBagBuilds, linkExternals } from "../build.js";
import { fileURLToPath } from "url";

/** Repo root, so the test does not depend on where vitest was invoked. */
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
import { getBagBuildDir } from "../paths.js";

/**
 * Writes a minimal but real bag: manifest, entry shim, and a tools module.
 * `extra` is appended to the source so individual tests can introduce syntax
 * that plain Node could not type-strip.
 */
function writeBag(root: string, name: string, extra = ""): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "bag.yaml"),
    `name: ${name}\ndescription: test bag\n`,
    "utf-8",
  );
  writeFileSync(join(dir, "tools.ts"), 'export * from "./src/tools.js";\n', "utf-8");
  writeFileSync(
    join(dir, "src", "tools.ts"),
    `export const sample = {
  name: "${name}_sample",
  namespace: "${name}",
  access: "read" as const,
  description: "sample",
  schema: {},
  handler: async (): Promise<string> => "ok",
};
${extra}
`,
    "utf-8",
  );
  return dir;
}

/**
 * Push a file's mtime clearly past the build output's.
 *
 * A test writes and rebuilds within the same second, and the staleness check is
 * a strict `>` on mtimeMs — so without this the control is decided by timer
 * resolution rather than by the code under test.
 */
function touchFuture(path: string): void {
  const when = new Date(Date.now() + 10_000);
  utimesSync(path, when, when);
}

describe("bag build", () => {
  let tmpDir: string;
  let buildDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bags-build-"));
    buildDir = join(tmpDir, "build");
    process.env.BARRY_BAGS_BUILD_DIR = buildDir;
    // An EMPTY builtin dir means "no builtins"; a missing one is a loud error.
    mkdirSync(join(tmpDir, "no-builtins"), { recursive: true });
    process.env.BARRY_BUILTIN_DIR = join(tmpDir, "no-builtins");
    process.env.BARRY_BAGS_SNAPSHOT = join(tmpDir, "bags.snapshot.json");
  });

  afterEach(() => {
    delete process.env.BARRY_BAGS_BUILD_DIR;
    delete process.env.BARRY_BUILTIN_DIR;
    delete process.env.BARRY_BAGS_SNAPSHOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // The wiring half of shareBuiltinDirWithBundles: a helper nothing calls
  // fixes nothing. Loading a built bundle must first hand it the running
  // checkout's builtin directory, so the bundle's own pinned path (stale after
  // a move) never applies in-process.
  it("builds only the standalone bag and prunes retired slash-registered extension builds", () => {
    const dir = writeBag(tmpDir, "session-vector-search");
    writeFileSync(join(dir, "bag.yaml"), "name: session-vector-search\ndescription: Search\n");
    writeFileSync(process.env.BARRY_BAGS_SNAPSHOT!, JSON.stringify({ bags: {
      "session-vector-search": { type: "local", path: dir },
      "sessions/search": { type: "local", path: dir },
    } }));
    const bags = discoverBuildableBags();
    expect(bags.map((bag) => bag.name)).toEqual(["session-vector-search"]);
    const live = getBagBuildDir("session-vector-search", dir);
    expect(live).toMatch(/\/session-vector-search-[a-f0-9]{8}$/);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "tools.js"), "export {};\n");
    const stale = getBagBuildDir("sessions/search", dir);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "tools.js"), "export {};\n");
    expect(pruneOrphanedBagBuilds(bags)).toEqual([stale.split("/").at(-1)]);
    expect(existsSync(live)).toBe(true);
  });

  it("finding a built entry shares the live builtin dir before the bundle loads", () => {
    const bagDir = join(tmpDir, "iota");
    mkdirSync(join(getBagBuildDir("iota", bagDir)), { recursive: true });
    writeFileSync(join(getBagBuildDir("iota", bagDir), "tools.js"), "export {};\n");
    delete process.env.BARRY_BUILTIN_DIR;

    expect(getBuiltBagEntry("iota", bagDir)).not.toBeNull();
    expect(process.env.BARRY_BUILTIN_DIR).toBeTruthy();
    expect(existsSync(process.env.BARRY_BUILTIN_DIR!)).toBe(true);
  });

  function registerBags(entries: Record<string, string>): void {
    const bags = Object.fromEntries(Object.entries(entries).map(([name, dir]) => [name, { type: "local", path: dir }]));
    writeFileSync(join(tmpDir, "bags.snapshot.json"), JSON.stringify({ bags }), "utf-8");
  }

  it("discovers local bags that declare a tools entry", () => {
    const dir = writeBag(tmpDir, "alpha");
    registerBags({ alpha: dir });

    const found = discoverBuildableBags();
    expect(found.map((p) => p.name)).toEqual(["alpha"]);
    expect(found[0].entry).toBe(join(dir, "tools.ts"));
  });

  it("skips a bag whose manifest does not parse, and still finds the others", () => {
    // One invalid registered manifest must not hide other buildable bags.
    // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
    const good = writeBag(tmpDir, "good");
    const broken = join(tmpDir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "tools.ts"), "export const tools = [];", "utf-8");
    // Valid YAML, invalid manifest: platform is not a value the schema allows.
    writeFileSync(
      join(broken, "bag.yaml"),
      "name: broken\ndescription: d\napps:\n  A:\n    description: d\n    platform: solaris\n",
      "utf-8",
    );
    registerBags({ good, broken });

    warning.mockClear();
    try {
      expect(discoverBuildableBags().map((p) => p.name)).toEqual(["good"]);
      // Silent skipping would make a broken bag look like one that simply
      // declares no tools, so the warning naming the bag is part of the fix.
      expect(warning).toHaveBeenCalledWith("sdk-bags", expect.stringContaining("broken"));
    } finally {
      warning.mockClear();
    }
  });

  it("builds a bag to plain JS that loads under the current runtime", async () => {
    const dir = writeBag(tmpDir, "beta");
    registerBags({ beta: dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok).toBe(true);
    expect(existsSync(join(getBagBuildDir("beta", dir), "tools.js"))).toBe(true);

    const mod = await import(result.outFile!);
    expect((mod as { sample: { name: string } }).sample.name).toBe("beta_sample");
  });

  // The whole point of building: Node's strip-only mode rejects enums and
  // parameter properties outright, so a raw-TS bag using them silently
  // vanished in production. After bundling they are ordinary JavaScript.
  it("accepts syntax that plain-Node type stripping rejects", async () => {
    const dir = writeBag(
      tmpDir,
      "gamma",
      `export enum Mode { Fast = "fast" }
export class Widget {
  constructor(public readonly label: string) {}
}
`,
    );
    registerBags({ gamma: dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok).toBe(true);

    const mod = (await import(result.outFile!)) as {
      Mode: Record<string, string>;
      Widget: new (label: string) => { label: string };
    };
    expect(mod.Mode.Fast).toBe("fast");
    expect(new mod.Widget("x").label).toBe("x");
  });

  it("loads a bundle that reads shipped model catalog assets and mixes static and dynamic zod imports", async () => {
    const sdkDir = fileURLToPath(new URL("../../..", import.meta.url));
    const dir = writeBag(
      tmpDir,
      "catalog-and-zod",
      `import { SHIPPED_VENDORS } from "@barry-rocks/sdk/adapters/models";
import { defineTool } from "@barry-rocks/sdk/tools";
import "unrelated-pure-package";
export const vendorCount = SHIPPED_VENDORS.length;
export const lazyZod = () => import("zod");
export const defined = defineTool({
  name: "catalog_and_zod_check",
  namespace: "catalog-and-zod",
  access: "read",
  description: "check",
  schema: {},
  handler: async () => "ok",
});
`,
    );
    mkdirSync(join(dir, "node_modules", "@barry-rocks"), { recursive: true });
    symlinkSync(sdkDir, join(dir, "node_modules", "@barry-rocks", "sdk"), "dir");
    symlinkSync(join(sdkDir, "node_modules", "zod"), join(dir, "node_modules", "zod"), "dir");
    const purePackage = join(dir, "node_modules", "unrelated-pure-package");
    mkdirSync(purePackage);
    writeFileSync(join(purePackage, "package.json"), JSON.stringify({ name: "unrelated-pure-package", type: "module", main: "index.js", sideEffects: false }));
    writeFileSync(join(purePackage, "index.js"), 'throw new Error("unrelated package annotations were ignored");');
    registerBags({ "catalog-and-zod": dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok, result.error).toBe(true);

    const mod = (await import(result.outFile!)) as {
      vendorCount: number;
      defined: { name: string };
      lazyZod: () => Promise<typeof import("zod")>;
    };
    const zod = await mod.lazyZod();
    expect(zod.z.custom<string>(value => typeof value === "string").parse("ok")).toBe("ok");
    expect(mod.vendorCount).toBeGreaterThan(0);
    expect(mod.defined.name).toBe("catalog_and_zod_check");
  });

  /**
   * A bag's own dependency declared in `barry.build.externals`: left out of the bundle
   * and linked beside it. The fixture package reads its package.json off
   * `import.meta.url` at load, as the SP-API SDK does, so the test also proves it
   * runs from its real location rather than from the build cache.
   */
  function writeBagWithExternal(name: string, installed: boolean): string {
    const dir = writeBag(tmpDir, name, 'import { version } from "local-dep";\nexport const depVersion = version;\n');
    writeFileSync(
      join(dir, "bag.yaml"),
      `name: ${name}\ndescription: test bag\n`,
      "utf-8",
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", barry: { build: { externals: ["local-dep"] } } }));
    if (installed) {
      const dep = join(dir, "node_modules", "local-dep");
      mkdirSync(dep, { recursive: true });
      writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "local-dep", version: "1.2.3", type: "module", main: "index.js" }));
      writeFileSync(
        join(dep, "index.js"),
        'import { readFileSync } from "node:fs";\nexport const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));\n',
      );
    }
    return dir;
  }

  it("links a bag's own externals so its bundle loads them from the bag", async () => {
    const dir = writeBagWithExternal("gamma", true);
    registerBags({ gamma: dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok).toBe(true);

    const mod = (await import(result.outFile!)) as { depVersion: string };
    expect(mod.depVersion).toBe("1.2.3");
  });

  it("fails the build, naming it, when a declared external is not installed", async () => {
    const dir = writeBagWithExternal("delta", false);
    registerBags({ delta: dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/external "local-dep" is not installed/);
  });

  it("reports a failure instead of throwing when a bag cannot build", async () => {
    const dir = writeBag(tmpDir, "broken");
    writeFileSync(join(dir, "src", "tools.ts"), "export const broken = (((;\n", "utf-8");
    registerBags({ broken: dir });

    const [result] = await buildBags({ force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("treats missing output as stale so a purged cache rebuilds", async () => {
    const dir = writeBag(tmpDir, "delta");
    registerBags({ delta: dir });

    await buildBags({ force: true });
    const [bag] = discoverBuildableBags();
    expect(isBagBuildStale(bag)).toBe(false);
    expect(getBuiltBagEntry("delta", dir)).toBeTruthy();

    // Simulate macOS purging ~/Library/Caches.
    rmSync(buildDir, { recursive: true, force: true });
    expect(isBagBuildStale(bag)).toBe(true);
    expect(getBuiltBagEntry("delta", dir)).toBeNull();

    const rebuilt = await buildBags({ force: false });
    expect(rebuilt[0].ok).toBe(true);
    expect(getBuiltBagEntry("delta", dir)).toBeTruthy();
  });

  // Freshness looked only at TypeScript mtimes, so a manifest or dependency
  // change left the previous bundle in place indefinitely — ordinary builds and
  // MCP startup kept serving code the manifest no longer selects.
  describe("non-source build inputs invalidate the bundle", () => {
    it("rebuilds after a manifest-only change while preserving the conventional entry", async () => {
      const dir = writeBag(tmpDir, "zeta");
      registerBags({ zeta: dir });

      await buildBags({ force: true });
      const before = await import(`${getBuiltBagEntry("zeta", dir)}?v=1`) as {
        sample: { handler: () => Promise<string> };
      };
      expect(await before.sample.handler()).toBe("ok");

      // Manifest-only edit: no .ts file is touched.
      writeFileSync(
        join(dir, "bag.yaml"),
        "name: zeta\ndescription: changed manifest description\n",
        "utf-8",
      );
      touchFuture(join(dir, "bag.yaml"));

      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(true);

      await buildBags({ force: false });
      const after = await import(`${getBuiltBagEntry("zeta", dir)}?v=2`) as {
        sample: { handler: () => Promise<string> };
      };
      // A manifest edit rebuilds without changing conventional entry selection.
      expect(await after.sample.handler()).toBe("ok");
    });

    it("rebuilds after a package.json-only change", async () => {
      const dir = writeBag(tmpDir, "eta");
      writeFileSync(join(dir, "package.json"), '{"name":"eta","version":"1.0.0"}\n', "utf-8");
      registerBags({ eta: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(false);

      writeFileSync(join(dir, "package.json"), '{"name":"eta","version":"2.0.0"}\n', "utf-8");
      touchFuture(join(dir, "package.json"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    it("rebuilds after a lockfile-only change", async () => {
      const dir = writeBag(tmpDir, "theta");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n", "utf-8");
      registerBags({ theta: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(false);

      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n# bumped\n", "utf-8");
      touchFuture(join(dir, "pnpm-lock.yaml"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    // The check reads what the bundle was built from, not the whole bag: a
    // bag's tree can hold a native app, and walking it on every launch was
    // most of `barry`'s startup.
    it("records the files the bundle was built from, and ignores source it never imported", async () => {
      const dir = writeBag(tmpDir, "kappa");
      mkdirSync(join(dir, "app", ".build"), { recursive: true });
      writeFileSync(join(dir, "app", ".build", "generated.ts"), "export const unused = 1;\n", "utf-8");
      registerBags({ kappa: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      const recorded = JSON.parse(readFileSync(join(getBagBuildDir("kappa", dir), "tools.inputs.json"), "utf-8")) as { files: string[] };
      expect(recorded.files.sort()).toEqual([join(dir, "src", "tools.ts"), join(dir, "tools.ts")].sort());

      touchFuture(join(dir, "app", ".build", "generated.ts"));
      expect(isBagBuildStale(bag)).toBe(false);
      touchFuture(join(dir, "src", "tools.ts"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    it("rebuilds after a bundled file is deleted, so its absence surfaces", async () => {
      const dir = writeBag(tmpDir, "lambda", 'export { helper } from "./helper.js";\n');
      writeFileSync(join(dir, "src", "helper.ts"), "export const helper = 1;\n", "utf-8");
      registerBags({ lambda: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(false);
      rmSync(join(dir, "src", "helper.ts"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    // A bag bundles its linked workspace packages in, so a change there makes
    // the bundle stale with nothing under the bag itself touched.
    it("rebuilds after a linked workspace dependency's bundled source changes", async () => {
      const dep = join(tmpDir, "workspace-dep");
      mkdirSync(join(dep, "src"), { recursive: true });
      writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "@barry-rocks/workspace-dep", type: "module", exports: { ".": "./src/index.ts" } }), "utf-8");
      writeFileSync(join(dep, "src", "index.ts"), "export const fromDep = 1;\n", "utf-8");
      const dir = writeBag(tmpDir, "mu", 'export { fromDep } from "@barry-rocks/workspace-dep";\n');
      mkdirSync(join(dir, "node_modules", "@barry-rocks"), { recursive: true });
      symlinkSync(dep, join(dir, "node_modules", "@barry-rocks", "workspace-dep"));
      registerBags({ mu: dir });

      const [result] = await buildBags({ force: true });
      expect(result.ok).toBe(true);
      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(false);
      touchFuture(join(dep, "src", "index.ts"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    it("walks the bag for a bundle built before its inputs were recorded", async () => {
      const dir = writeBag(tmpDir, "nu");
      writeFileSync(join(dir, "src", "unimported.ts"), "export const x = 1;\n", "utf-8");
      registerBags({ nu: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      rmSync(join(getBagBuildDir("nu", dir), "tools.inputs.json"));
      expect(isBagBuildStale(bag)).toBe(false);
      // The walk counts any TypeScript in the bag, imported or not.
      touchFuture(join(dir, "src", "unimported.ts"));
      expect(isBagBuildStale(bag)).toBe(true);
    });

    // Discrimination: if everything were stale, the assertions above would pass
    // regardless of what the check reads.
    it("leaves an untouched bag fresh, and ignores files that do not affect the bundle", async () => {
      const dir = writeBag(tmpDir, "iota");
      registerBags({ iota: dir });

      await buildBags({ force: true });
      const [bag] = discoverBuildableBags();
      expect(isBagBuildStale(bag)).toBe(false);

      writeFileSync(join(dir, "README.md"), "# docs\n", "utf-8");
      touchFuture(join(dir, "README.md"));
      writeFileSync(join(dir, "src", "tools.test.ts"), "// a test\n", "utf-8");
      touchFuture(join(dir, "src", "tools.test.ts"));
      expect(isBagBuildStale(bag)).toBe(false);
    });
  });

  it("skips bags whose registry entry is disabled", () => {
    const dir = writeBag(tmpDir, "epsilon");
    writeFileSync(
      join(tmpDir, "bags.snapshot.json"),
      JSON.stringify({ bags: { epsilon: { type: "local", path: dir, access: "disabled" } } }),
      "utf-8",
    );
    expect(discoverBuildableBags()).toEqual([]);
  });
  // Two checkouts of the same bag (a git worktree, a second clone) share a
  // build root. Keyed by name alone they shared one output directory, and
  // because staleness is an mtime comparison, whichever built last served its
  // tools to both — a rename applied in a worktree silently had no effect.
  it("does not share build output between two checkouts of one bag", async () => {
    const checkoutA = writeBag(join(tmpDir, "a"), "zeta");
    const checkoutB = writeBag(join(tmpDir, "b"), "zeta");

    expect(getBagBuildDir("zeta", checkoutA)).not.toBe(getBagBuildDir("zeta", checkoutB));

    registerBags({ zeta: checkoutA });
    const [built] = await buildBags({ force: true });
    expect(built.ok).toBe(true);

    // The other checkout has no build of its own, so it must not resolve to
    // this one's.
    expect(getBuiltBagEntry("zeta", checkoutB)).toBeNull();
    expect(getBuiltBagEntry("zeta", checkoutA)).toBeTruthy();
  });
  // Build dirs are keyed by name AND source dir, so they accumulate: removed
  // bags, deleted worktrees, and the old name-only layout all leave output
  // that nothing will read again.
  it("prunes build output no live bag claims", async () => {
    const dir = writeBag(tmpDir, "eta");
    registerBags({ eta: dir });
    await buildBags({ force: true });

    const live = getBagBuildDir("eta", dir);
    expect(existsSync(join(live, "tools.js"))).toBe(true);

    // Stand in for a stale checkout and the pre-scoping name-only directory.
    // Both must look like real build output — a bare directory is deliberately
    // left alone, since the prune only removes what it positively recognises.
    const orphan = join(buildDir, "eta-deadbeef");
    const legacy = join(buildDir, "eta");
    for (const d of [orphan, legacy]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "tools.js"), "export const sample = {};\n", "utf-8");
    }

    const removed = pruneOrphanedBagBuilds(discoverBuildableBags());

    expect(removed.sort()).toEqual(["eta", "eta-deadbeef"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(live, "tools.js"))).toBe(true);
  });

  it("prunes nothing when every directory is claimed", async () => {
    const dir = writeBag(tmpDir, "theta");
    registerBags({ theta: dir });
    await buildBags({ force: true });
    expect(pruneOrphanedBagBuilds(discoverBuildableBags())).toEqual([]);
  });
  // node_modules at the build root holds the external symlinks every built bag
  // resolves through. Pruning it made 8 bags fail to load with "Cannot find
  // package 'better-sqlite3'" — the tool count dropped 289 -> 234.
  it("never prunes the externals node_modules", async () => {
    const dir = writeBag(tmpDir, "iota");
    registerBags({ iota: dir });
    await buildBags({ force: true });

    const externals = join(buildDir, "node_modules");
    mkdirSync(externals, { recursive: true });
    // Even if something under it happens to be named tools.js, node_modules
    // itself is not build output.
    writeFileSync(join(externals, "tools.js"), "// not bag output\n", "utf-8");

    expect(pruneOrphanedBagBuilds(discoverBuildableBags())).not.toContain("node_modules");
    expect(existsSync(externals)).toBe(true);
  });
  // Externals are resolved from this module's location, not process.cwd(): the
  // MCP server runs with cwd=engine, where several externals are invisible.
  // Resolving from cwd linked only 4 of 8 and took 8 bags down on a cold cache
  // — silently, since the missing list was discarded.
  it("links every external regardless of the working directory", () => {
    const fromMcpCwd = linkExternals(join(REPO_ROOT, "servers", "mcp"));
    const fromRepoRoot = linkExternals(REPO_ROOT);
    // The guard: both cwds must find the same externals — the bug was cwd-dependent resolution.
    // Missing externals are allowed (some are only installed when their consumer bag is present).
    expect(fromMcpCwd.linked.sort()).toEqual(fromRepoRoot.linked.sort());
    expect(fromMcpCwd.missing.sort()).toEqual(fromRepoRoot.missing.sort());
  });
});

const warning = vi.hoisted(() => vi.fn());
vi.mock("../../logging/emit.js", async original => {
  const logging = await original<typeof import("../../logging/emit.js")>();
  return { ...logging, createLogger(...args: Parameters<typeof logging.createLogger>) {
    const logger = logging.createLogger(...args);
    return { ...logger, warn(...messages: Parameters<typeof logger.warn>) { warning(args[0], messages[0]); logger.warn(...messages); } };
  } };
});
