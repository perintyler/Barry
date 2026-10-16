import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadBag, loadBags, loadAllBags, getInvalidManifests, bagLoadStamp, loadBagSync, expandCompositionSync, pruneBagDiskCaches } from "../loader.js";
import { contractDerivation } from "../../tools/tool-contract.js";
import { addSnapshotBag } from "./snapshot-fixture.js";
import type { Bag } from "../types.js";
import { getBagBuildDir } from "../paths.js";

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/emit.js")>();
  return { ...actual, createLogger: (...args: Parameters<typeof actual.createLogger>) => ({
    ...actual.createLogger(...args), warn: diagnostics.warn,
  }) };
});

async function resolveLoadBag(name: string): Promise<Bag | null> {
  const result = loadBag(name);
  return result instanceof Promise ? result : result;
}


/** A summarized tool: what it declares, and the contract hash read from its code. */
const READ_META = { toolName: "read", namespace: "documents", access: "read", contractHash: expect.stringMatching(/^[0-9a-f]{64}$/), description: "Read documents" };

describe("loader", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bags-loader-"));
    registryPath = join(tmpDir, "bags.snapshot.json");
    process.env.BARRY_BAGS_SNAPSHOT = registryPath;
    // An EMPTY builtin dir means "no builtins"; a missing one is a loud error.
    mkdirSync(join(tmpDir, "no-builtins"), { recursive: true });
    process.env.BARRY_BUILTIN_DIR = join(tmpDir, "no-builtins");
  });

  afterEach(() => {
    delete process.env.BARRY_BAGS_SNAPSHOT;
    delete process.env.BARRY_BUILTIN_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a standalone bag and degrades a retired slash-registered extension row", async () => {
    const dir = join(tmpDir, "search");
    mkdirSync(dir);
    writeFileSync(join(dir, "bag.yaml"), "name: session-vector-search\ndescription: Search\n");
    addSnapshotBag("session-vector-search", { type: "local", path: dir });
    addSnapshotBag("sessions/search", { type: "local", path: dir });
    expect(await resolveLoadBag("session-vector-search")).toMatchObject({ name: "session-vector-search", manifest: { name: "session-vector-search" } });
    expect(await resolveLoadBag("sessions/search")).toMatchObject({ name: "sessions/search", manifest: null, tools: [] });
    expect(getInvalidManifests().get("sessions/search")).toMatch(/session-vector-search.*barry bag doctor --fix/);
  });

  it("preserves invalid manifest diagnostics in a fresh process disk cache", async () => {
    const dir = join(tmpDir, "bad-disk"); mkdirSync(dir);
    writeFileSync(join(dir, "bag.yaml"), "name: bad-disk\nbogusKey: true\n");
    addSnapshotBag("bad-disk", { type: "local", path: dir });
    expandCompositionSync(["bad-disk"]);
    vi.resetModules();
    const manifest = await import("../manifest.js");
    const parse = vi.spyOn(manifest, "parseManifest");
    const fresh = await import("../loader.js");
    fresh.loadBagSync("bad-disk");
    expect(parse).not.toHaveBeenCalled();
    expect(fresh.getInvalidManifests().get("bad-disk")).toContain("bogusKey");
    parse.mockRestore();
  });
  it.each(["src/tools.ts", "tools.ts"])("invalidates cached manifests when %s is added", async entry => {
    const dir = join(tmpDir, "new-tools"); mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "bag.yaml"), "version: v0.1\nname: new-tools\ndescription: New tools\n");
    addSnapshotBag("new-tools", { type: "local", path: dir });
    expect(loadBagSync("new-tools")?.manifest?.toolsEntry).toBeUndefined();
    vi.resetModules();
    writeFileSync(join(dir, entry), "export const tool = {};");
    const fresh = await import("../loader.js");
    expect(fresh.loadBagSync("new-tools")?.manifest?.toolsEntry?.entry).toBe(entry);
  });
  it("prunes old snapshot generations without deleting recent or unrelated files", () => {
    const old = new Date(Date.now() - 120_000);
    for (const kind of ["snapshot", "manifests"]) for (let i = 0; i < 5; i++) {
      const path = join(tmpDir, `${kind}-${i}.json`); writeFileSync(path, "{}"); utimesSync(path, old, new Date(old.getTime() + i));
    }
    writeFileSync(join(tmpDir, "snapshot-abcdef.json"), "{}");
    writeFileSync(join(tmpDir, "unrelated.json"), "{}");
    pruneBagDiskCaches(tmpDir);
    expect(existsSync(join(tmpDir, "snapshot-0.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "manifests-0.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "snapshot-abcdef.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "unrelated.json"))).toBe(true);
  });
  it("includes cached build failures in the aggregate launch warning", async () => {
    const dir = join(tmpDir, "cached-failure"); mkdirSync(dir);
    writeFileSync(join(dir, "bag.yaml"), "version: v0.1\nname: cached-failure\ndescription: Broken\n");
    writeFileSync(join(dir, "tools.ts"), 'import "@definitely/not-installed";');
    addSnapshotBag("cached-failure", { type: "local", path: dir });
    const build = await import("../build.js");
    await expect(build.ensureToolsBuilt({ name: "cached-failure", bagDir: dir, entry: join(dir, "tools.ts") })).rejects.toThrow();
    vi.resetModules(); diagnostics.warn.mockClear();
    const fresh = await import("../loader.js");
    const bags = await fresh.loadBags(["cached-failure"]);
    expect(bags[0].toolsError).toContain("@definitely/not-installed");
    expect(diagnostics.warn).toHaveBeenCalledWith(expect.stringContaining("1 bags could not load their tools"));
  });
  it("returns null for a bag the registry does not list", async () => {
    addSnapshotBag("present", { type: "local", path: tmpDir });
    expect(await loadBag("nonexistent")).toBeNull();
  });

  it("refuses to load anything without a registry snapshot, naming the fix", async () => {
    await expect(loadBag("anything")).rejects.toThrow(/snapshot is missing.*barry bag doctor --fix/);
  });

  it("carries a manifest bound definition through to the loaded bag", async () => {
    const bagDir = join(tmpDir, "bounded-bag");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(
      join(bagDir, "bag.yaml"),
      [
        "name: bounded-bag",
        "description: a bag whose bound restricts bash",
        "bounds:",
        "  restricted:",
        '    description: "denies raw git"',
        "    bash:",
        "      deny:",
        "        - git *",
        "",
      ].join("\n"),
    );
    addSnapshotBag("bounded-bag", { type: "local", path: bagDir });

    const bag = await resolveLoadBag("bounded-bag");
    const bound = bag?.bounds?.["bounded-bag:restricted"];
    expect(bound, "manifest bound did not load at all").toBeDefined();
    expect(bound?.bound.bash?.deny).toEqual(["git *"]);
  });

  it("returns null for disabled bag", async () => {
    addSnapshotBag("disabled-bag", { type: "local", path: "/some/path", disabled: true });
    expect(await loadBag("disabled-bag")).toBeNull();
  });

  it("loads a local bag with manifest", async () => {
    const bagDir = join(tmpDir, "my-bag");
    mkdirSync(bagDir, { recursive: true });
    mkdirSync(join(bagDir, "skills"), { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), `
version: v0.1
name: my-bag
description: Test bag
mcp-servers:
  test-api:
    type: http
    url: http://localhost:9999/mcp
bounds:
  custom:
    description: Custom bound
    tools:
      allow: [test-api:read]
`);

    writeFileSync(join(bagDir, "tools.ts"), 'export const read = { name: "read", namespace: "documents", access: "read", description: "Read documents", schema: {}, handler: async () => "ok" };');
    addSnapshotBag("my-bag", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("my-bag");

    expect(bag).not.toBeNull();
    expect(bag!.name).toBe("my-bag");
    expect(bag!.description).toBe("Test bag");
    expect(bag!.skillsDirs).toHaveLength(1);
    expect(Object.keys(bag!.bounds ?? {})).toEqual(["my-bag:custom"]);
    expect(Object.keys(bag!.mcpServers)).toEqual(["test-api"]);
    expect(bag!.manifest?.toolsEntry?.entry).toBe("tools.ts");
    expect(bag!.tools).toEqual([READ_META]);
  });

  it("loads a local bag without manifest (skills-only)", async () => {
    const bagDir = join(tmpDir, "skills-only");
    mkdirSync(join(bagDir, "skills"), { recursive: true });

    addSnapshotBag("skills-only", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("skills-only");

    expect(bag).not.toBeNull();
    expect(bag!.name).toBe("skills-only");
    expect(bag!.manifest).toBeNull();
    expect(bag!.skillsDirs).toHaveLength(1);
    expect(bag!.bounds).toBeUndefined();
  });

  it("degrades a bag with an invalid manifest instead of throwing", async () => {
    // loadAllBags walks every registered bag, so an unguarded parse error
    // here takes down tool loading, the launchd emitter, and bag doctor for
    // every OTHER bag too. One third-party bag written against an older
    // schema should not read as "Barry is broken".
    const bagDir = join(tmpDir, "bad-manifest");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(
      join(bagDir, "bag.yaml"),
      "name: bad-manifest\ndescription: has an unknown key\nbogusKey: true\n",
    );

    addSnapshotBag("bad-manifest", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("bad-manifest");

    expect(bag).not.toBeNull();
    expect(bag!.manifest).toBeNull();
    expect(bag!.tools).toEqual([]);
  });

  it("records an invalid manifest so a diagnostic can report it, and clears it once fixed", async () => {
    // The loader's warning goes to whichever process loaded the bag -- for a
    // service, a log nobody reads -- and the husk looks like a bag with no
    // tools. `barry bag doctor` reads this map to count it as a problem, so
    // it must name the bag AND the offending key, and forget a fixed bag.
    const bagDir = join(tmpDir, "reported");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), "name: reported\ndescription: x\nbogusKey: true\n");
    addSnapshotBag("reported", { type: "local", path: bagDir });

    await resolveLoadBag("reported");
    expect(getInvalidManifests().get("reported")).toMatch(/bogusKey/);

    writeFileSync(join(bagDir, "bag.yaml"), "name: reported\ndescription: x\n");
    await resolveLoadBag("reported");
    expect(getInvalidManifests().has("reported")).toBe(false);
  });

  it("keeps loading other bags when one manifest is invalid", async () => {
    const badDir = join(tmpDir, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "bag.yaml"), "name: broken\ndescription: x\nbogusKey: true\n");

    const goodDir = join(tmpDir, "healthy");
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, "bag.yaml"), "name: healthy\ndescription: fine\n");

    addSnapshotBag("broken", { type: "local", path: badDir });
    addSnapshotBag("healthy", { type: "local", path: goodDir });

    const bags = await loadBags(["broken", "healthy"]);
    expect(bags.map((b) => b.name).sort()).toEqual(["broken", "healthy"]);
    expect(bags.find((b) => b.name === "healthy")!.manifest).not.toBeNull();
  });

  it("loads a remote bag as MCP server", async () => {
    addSnapshotBag("sentry", { type: "remote", url: "https://mcp.sentry.dev/mcp" });
    const bag = await resolveLoadBag("sentry");

    expect(bag).not.toBeNull();
    expect(bag!.name).toBe("sentry");
    expect(bag!.mcpServers.sentry).toEqual({ type: "http", url: "https://mcp.sentry.dev/mcp" });
    expect(bag!.manifest).toBeNull();
    expect(bag!.skillsDirs).toEqual([]);
  });

  it("loads a remote bag with command", async () => {
    addSnapshotBag("linear", {
      type: "remote",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      env: ["LINEAR_API_KEY"],
    });
    const bag = await resolveLoadBag("linear");

    expect(bag!.mcpServers.linear.command).toBe("npx");
    expect(bag!.mcpServers.linear.env).toEqual(["LINEAR_API_KEY"]);
  });

  it("loadBags skips disabled and missing bags", async () => {
    const bagDir = join(tmpDir, "good-bag");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), "name: good\ndescription: Good");

    addSnapshotBag("good", { type: "local", path: bagDir });
    addSnapshotBag("disabled", { type: "local", path: "/nope", disabled: true });

    const bags = await loadBags(["good", "disabled", "nonexistent"]);
    expect(bags).toHaveLength(1);
    expect(bags[0].name).toBe("good");
  });

  it("loadAllBags loads all non-disabled bags", async () => {
    const bagDir = join(tmpDir, "all-bag");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), "name: all-test\ndescription: All");

    addSnapshotBag("active", { type: "local", path: bagDir });
    addSnapshotBag("off", { type: "remote", url: "http://x", disabled: true });

    const bags = await loadAllBags();
    expect(bags).toHaveLength(1);
    expect(bags[0].name).toBe("all-test");
  });

  it("marks builtin bags with builtin: true", async () => {
    // Builtin = ships with Barry, i.e. a bag.yaml inside the builtin directory.
    const builtinDir = join(tmpDir, "bags");
    const shippedBag = join(builtinDir, "shipped");
    mkdirSync(shippedBag, { recursive: true });
    writeFileSync(join(shippedBag, "bag.yaml"), "name: shipped\ndescription: A shipped bag\n");
    process.env.BARRY_BUILTIN_DIR = builtinDir;

    // Shipped bags reach the registry the way every bag does: seeded into the
    // snapshot. Builtin-ness is still decided by the builtin directory.
    addSnapshotBag("shipped", { type: "local", path: shippedBag });
    addSnapshotBag("sentry", { type: "remote", url: "https://mcp.sentry.dev/mcp" });
    addSnapshotBag("my-tool", { type: "local", path: tmpDir });

    const shipped = await resolveLoadBag("shipped");
    const sentry = await resolveLoadBag("sentry");
    const myTool = await resolveLoadBag("my-tool");

    expect(shipped!.builtin).toBe(true);
    // A registered remote server is a third-party service, not Barry's own bag.
    expect(sentry!.builtin).toBe(false);
    expect(myTool!.builtin).toBe(false);
  });

  // Loading a bag needs only its tools' names, namespaces and access, and
  // importing every bundle to read them was ~7s of CPU per launch.
  describe("the summary of a bag's tools, kept beside its bundle", () => {
    beforeEach(() => {
      process.env.BARRY_BAGS_BUILD_DIR = join(tmpDir, "build");
    });

    afterEach(() => {
      delete process.env.BARRY_BAGS_BUILD_DIR;
    });

    function writeToolBag(name: string, tools: string): string {
      const bagDir = join(tmpDir, name);
      mkdirSync(bagDir, { recursive: true });
      writeFileSync(join(bagDir, "bag.yaml"), `version: v0.1\nname: ${name}\ndescription: ${name}\n`);
      writeFileSync(join(bagDir, "tools.ts"), tools);
      addSnapshotBag(name, { type: "local", path: bagDir });
      return bagDir;
    }

    const READ = 'export const read = { name: "read", namespace: "documents", access: "read", description: "Read documents", schema: {}, handler: async () => "ok" };';

    it("is written by the first load, from the bundle", async () => {
      const bagDir = writeToolBag("summarized", READ);
      const bag = await loadBag("summarized");

      expect(bag?.tools).toEqual([READ_META]);
      const summary = JSON.parse(readFileSync(join(getBagBuildDir("summarized", bagDir), `tools.summary-${contractDerivation()}.json`), "utf-8"));
      expect(summary.tools).toEqual(bag?.tools);
    });

    it("is what a later load reads, while the bundle is unchanged", async () => {
      const bagDir = writeToolBag("trusted", READ);
      await loadBag("trusted");
      const summaryFile = join(getBagBuildDir("trusted", bagDir), `tools.summary-${contractDerivation()}.json`);
      const summary = JSON.parse(readFileSync(summaryFile, "utf-8"));
      writeFileSync(summaryFile, JSON.stringify({ ...summary, tools: [{ toolName: "from-summary", namespace: "documents", access: "read" }] }));

      expect((await loadBag("trusted"))?.tools).toEqual([{ toolName: "from-summary", namespace: "documents", access: "read" }]);
    });

    it("is read again from the bundle once the bundle is rebuilt", async () => {
      const bagDir = writeToolBag("rebuilt", READ);
      await loadBag("rebuilt");
      const summaryFile = join(getBagBuildDir("rebuilt", bagDir), `tools.summary-${contractDerivation()}.json`);
      writeFileSync(summaryFile, JSON.stringify({ stamp: "an older bundle", tools: [] }));

      expect((await loadBag("rebuilt"))?.tools).toEqual([READ_META]);
    });

    it("is never written for a bag whose tools fail to load", async () => {
      const bagDir = writeToolBag("never-summarized", 'throw new Error("nope");');
      const warn = diagnostics.warn.mockReset();
      try {
        const bag = await loadBag("never-summarized");
        expect(bag?.toolsError).toMatch(/nope/);
      } finally {
        warn.mockReset();
      }
      expect(existsSync(join(getBagBuildDir("never-summarized", bagDir), `tools.summary-${contractDerivation()}.json`))).toBe(false);
    });
  });

  describe("a bag whose tool code fails to load", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      process.env.BARRY_BAGS_BUILD_DIR = join(tmpDir, "build");
      warn = diagnostics.warn.mockReset();
    });

    afterEach(() => {
      delete process.env.BARRY_BAGS_BUILD_DIR;
      warn.mockReset();
    });

    function writeBag(name: string, tools: string, extraYaml = ""): void {
      const bagDir = join(tmpDir, name);
      mkdirSync(bagDir, { recursive: true });
      writeFileSync(join(bagDir, "bag.yaml"), `version: v0.1\nname: ${name}\ndescription: ${name}\n${extraYaml}`);
      writeFileSync(join(bagDir, "tools.ts"), tools);
      addSnapshotBag(name, { type: "local", path: bagDir });
    }

    it("expands composition without loading either bag's tool code", () => {
      writeBag("parent", 'throw new Error("must not load");', "bags: [child]\n");
      writeBag("child", 'throw new Error("must not load");');
      const first = loadBagSync("parent");
      expect(loadBagSync("parent")).toBe(first);
      expect(expandCompositionSync(["parent"])).toEqual(["parent", "child"]);
      expect(existsSync(join(getBagBuildDir("parent", join(tmpDir, "parent")), "tools.js"))).toBe(false);
      expect(first?.toolsError).toBeUndefined();
    });

    it("reuses a disk manifest snapshot across processes and invalidates edited manifests", async () => {
      writeBag("disk-parent", 'throw new Error("must not load");', "bags: [disk-child]\n");
      writeBag("disk-child", 'throw new Error("must not load");');
      expect(expandCompositionSync(["disk-parent"])).toEqual(["disk-parent", "disk-child"]);
      vi.resetModules();
      const manifest = await import("../manifest.js");
      const parse = vi.spyOn(manifest, "parseManifest");
      const fresh = await import("../loader.js");
      expect(fresh.expandCompositionSync(["disk-parent"])).toEqual(["disk-parent", "disk-child"]);
      expect(parse).not.toHaveBeenCalled();
      writeFileSync(join(tmpDir, "disk-parent", "bag.yaml"), "version: v0.1\nname: disk-parent\ndescription: changed\nbags: []\n");
      expect(fresh.expandCompositionSync(["disk-parent"])).toEqual(["disk-parent"]);
      expect(parse).toHaveBeenCalled();
      parse.mockRestore();
    });

    // Regression. Since tool metadata moved into code, loadBag imports every
    // bag's tools and threw when one failed; loadBags is a Promise.all, so a
    // single broken bag rejected the registry snapshot, `bag doctor`, and the
    // identity sync for every other bag.
    it("degrades that bag instead of rejecting the whole load", async () => {
      writeBag("broken", 'throw new Error("BROKEN_API_KEY not set");', "bags: [fine]\n");
      writeBag("fine", 'export const read = { name: "read", namespace: "documents", access: "read", description: "Read documents", schema: {}, handler: async () => "ok" };');

      const bags = await loadBags(["broken", "fine"]);

      expect(bags.map((b) => b.name)).toEqual(["broken", "fine"]);
      const [broken, fine] = bags;
      expect(broken.toolsError).toMatch(/BROKEN_API_KEY not set/);
      expect(broken.tools).toEqual([]);
      // The manifest survives: composition, services, schedules still load.
      expect(broken.manifest?.bags).toEqual(["fine"]);
      expect(fine.toolsError).toBeUndefined();
      expect(fine.tools).toEqual([READ_META]);
    });

    // The bag-name guess is wrong whenever the code stamps another namespace,
    // and here nobody can see what it stamps. A guessed grant is hollow.
    it("contributes no guessed tools when tool code fails to load", async () => {
      writeBag("broken", 'throw new Error("nope");');
      const [broken] = await loadBags(["broken"]);
      expect(broken.tools).toEqual([]);
    });

    it("reports one aggregate warning for the process rather than one per bag", async () => {
      vi.resetModules();
      const fresh = await import("../loader.js");
      writeBag("broken-twice", 'throw new Error("nope");');
      writeBag("also-broken", 'throw new Error("nope");');
      await fresh.loadBags(["broken-twice", "also-broken"]);
      await fresh.loadBags(["broken-twice", "also-broken"]);
      const warnings = warn.mock.calls.filter(([message]) => String(message).includes("bags could not load their tools"));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain("2 bags");
    });
  });

  it("keeps a bound named after its bag bare and qualifies other bounds", async () => {
    const bagDir = join(tmpDir, "escalate");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), `
version: v0.1
name: escalate
description: Escalation
mcp-servers:
  slack: { type: http, url: http://localhost:9999/mcp }
bounds:
  escalate:
    description: Deep reads only
    tools:
      allow: [datadog:read]
  helper:
    description: Qualified as usual
    tools:
      allow: [datadog]
`);
    addSnapshotBag("escalate", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("escalate");

    expect(Object.keys(bag!.bounds ?? {}).sort()).toEqual(["escalate", "escalate:helper"]);
  });

  describe("bagLoadStamp", () => {
    function writeManifest(name: string, extraYaml = ""): string {
      const bagDir = join(tmpDir, name);
      mkdirSync(bagDir, { recursive: true });
      const path = join(bagDir, "bag.yaml");
      writeFileSync(path, `version: v0.1\nname: ${name}\ndescription: ${name}\n${extraYaml}`);
      addSnapshotBag(name, { type: "local", path: bagDir });
      return path;
    }

    function touch(path: string, seconds: number): void {
      utimesSync(path, seconds, seconds);
    }

    it("is stable while nothing changes", () => {
      writeManifest("solo");
      expect(bagLoadStamp(["solo"])).toBe(bagLoadStamp(["solo"]));
    });

    it("changes when a manifest changes", () => {
      const manifest = writeManifest("solo");
      touch(manifest, 1_000_000);
      const before = bagLoadStamp(["solo"]);
      touch(manifest, 2_000_000);
      expect(bagLoadStamp(["solo"])).not.toBe(before);
    });

    // A sub-bag's manifest feeds its parent's auto-trait through absorption,
    // so a stamp over the requested names alone would miss it.
    it("covers the composition closure, not just the names given", () => {
      writeManifest("parent", "bags: [child]\n");
      const child = writeManifest("child");
      touch(child, 1_000_000);
      const before = bagLoadStamp(["parent"]);
      touch(child, 2_000_000);
      expect(bagLoadStamp(["parent"])).not.toBe(before);
    });

    // Every install and unregister rewrites the snapshot; stamping the whole
    // file re-synced every identity after each one.
    it("ignores registry changes to bags outside the closure", () => {
      writeManifest("solo");
      const before = bagLoadStamp(["solo"]);
      addSnapshotBag("unrelated", { type: "local", path: join(tmpDir, "unrelated") });
      expect(bagLoadStamp(["solo"])).toBe(before);
    });

    it("changes when a closure bag's registry entry changes", () => {
      writeManifest("solo");
      const before = bagLoadStamp(["solo"]);
      addSnapshotBag("solo", { type: "local", path: join(tmpDir, "solo"), access: "deferred" });
      expect(bagLoadStamp(["solo"])).not.toBe(before);
    });

    it("changes when the requested names change", () => {
      writeManifest("a");
      writeManifest("b");
      expect(bagLoadStamp(["a"])).not.toBe(bagLoadStamp(["a", "b"]));
    });

    it("changes when a skills directory gains an entry", () => {
      writeManifest("skilled");
      const skills = join(tmpDir, "skilled", "skills");
      mkdirSync(skills);
      touch(skills, 1_000_000);
      const before = bagLoadStamp(["skilled"]);
      mkdirSync(join(skills, "new-skill"));
      expect(bagLoadStamp(["skilled"])).not.toBe(before);
    });
  });
});
