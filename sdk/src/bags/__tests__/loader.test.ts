import { getAllTraits } from "../merge.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadBag, loadBags, loadAllBags, getInvalidManifests, bagLoadStamp } from "../loader.js";
import { ownNamespaces } from "../../traits/auto-traits.js";
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

  it("loads an extension by its registered name and degrades a stale row", async () => {
    const dir = join(tmpDir, "search");
    mkdirSync(dir);
    writeFileSync(join(dir, "bag.yaml"), "name: search\nextends: sessions\ndescription: Search\n");
    addSnapshotBag("sessions/search", { type: "local", path: dir });
    addSnapshotBag("sessions-search", { type: "local", path: dir });
    expect(await resolveLoadBag("sessions/search")).toMatchObject({ name: "sessions/search", manifest: { extends: "sessions" } });
    expect(await resolveLoadBag("sessions-search")).toMatchObject({ name: "sessions-search", manifest: null, tools: [] });
    expect(getInvalidManifests().get("sessions-search")).toMatch(/sessions\/search.*barry bag doctor --fix/);
  });

  it("returns null for a bag the registry does not list", async () => {
    addSnapshotBag("present", { type: "local", path: tmpDir });
    expect(await loadBag("nonexistent")).toBeNull();
  });

  it("refuses to load anything without a registry snapshot, naming the fix", async () => {
    await expect(loadBag("anything")).rejects.toThrow(/snapshot is missing.*barry bag doctor --fix/);
  });

  // Regression. This loop rebuilt each manifest trait field by field and did
  // not copy `bound`, so every inline restriction declared by a bag outside
  // this repo arrived at the traits table as `{}`. Nothing reported it:
  // parseManifest kept the bound, identity-bags stamped it, upsertTrait wrote
  // the column, and `barry bag sync-traits` printed success — the value was
  // simply gone before any of them saw it.
  //
  // It fails open, which is the direction that matters: the agent keeps the
  // grant and loses the restriction, and a trait with no teeth renders exactly
  // like one with teeth. Real case: the raw-git denial on `IC` in
  // ~/repos/bags/coding had never once been enforced.
  //
  // Asserting on denyPrograms rather than on `bound` being defined — an empty
  // `{}` is truthy and was the actual broken value.
  it("carries a manifest trait's inline bound through to the loaded trait", async () => {
    const bagDir = join(tmpDir, "bounded-bag");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(
      join(bagDir, "bag.yaml"),
      [
        "name: bounded-bag",
        "description: a bag whose trait restricts bash",
        "traits:",
        "  Restricted:",
        '    description: "grants the bag, denies raw git"',
        "    access: readwrite",
        "    bags: [bounded-bag]",
        "    bound:",
        "      bash:",
        "        denyPrograms:",
        "          - git",
        "",
      ].join("\n"),
    );
    addSnapshotBag("bounded-bag", { type: "local", path: bagDir });

    const bag = await resolveLoadBag("bounded-bag");
    const trait = bag?.traits.find((t) => t.name === "bounded-bag:Restricted");
    expect(trait, "manifest trait did not load at all").toBeDefined();
    expect(trait?.bound?.bash?.denyPrograms).toEqual(["git"]);
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
traits:
  custom:
    description: Custom trait
    access: read
    namespaces: [test-api]
`);

    writeFileSync(join(bagDir, "tools.ts"), 'export const read = { name: "read", namespace: "documents", access: "read", description: "Read documents", schema: {}, handler: async () => "ok" };');
    addSnapshotBag("my-bag", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("my-bag");

    expect(bag).not.toBeNull();
    expect(bag!.name).toBe("my-bag");
    expect(bag!.description).toBe("Test bag");
    expect(bag!.skillsDirs).toHaveLength(1);
    expect(bag!.traits).toHaveLength(1);
    expect(bag!.traits[0].name).toBe("my-bag:custom");
    expect(Object.keys(bag!.mcpServers)).toEqual(["test-api"]);
    expect(bag!.manifest?.toolsEntry?.entry).toBe("tools.ts");
    expect(bag!.tools).toEqual([READ_META]);
    const generated = getAllTraits(bag!).find(trait => trait.name === "my-bag");
    expect(generated?.bags).toEqual(["documents", "test-api"]);
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
    expect(bag!.traits).toEqual([]);
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
      const summary = JSON.parse(readFileSync(join(getBagBuildDir("summarized", bagDir), "tools.summary.json"), "utf-8"));
      expect(summary.tools).toEqual(bag?.tools);
    });

    it("is what a later load reads, while the bundle is unchanged", async () => {
      const bagDir = writeToolBag("trusted", READ);
      await loadBag("trusted");
      const summaryFile = join(getBagBuildDir("trusted", bagDir), "tools.summary.json");
      const summary = JSON.parse(readFileSync(summaryFile, "utf-8"));
      writeFileSync(summaryFile, JSON.stringify({ ...summary, tools: [{ toolName: "from-summary", namespace: "documents", access: "read" }] }));

      expect((await loadBag("trusted"))?.tools).toEqual([{ toolName: "from-summary", namespace: "documents", access: "read" }]);
    });

    it("is read again from the bundle once the bundle is rebuilt", async () => {
      const bagDir = writeToolBag("rebuilt", READ);
      await loadBag("rebuilt");
      const summaryFile = join(getBagBuildDir("rebuilt", bagDir), "tools.summary.json");
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
      expect(existsSync(join(getBagBuildDir("never-summarized", bagDir), "tools.summary.json"))).toBe(false);
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
    it("contributes no guessed namespace", async () => {
      writeBag("broken", 'throw new Error("nope");');
      const [broken] = await loadBags(["broken"]);
      expect([...ownNamespaces(broken)]).toEqual([]);
    });

    // Own bag name: the dedupe is per process, so a name an earlier test
    // already failed with the same reason would never warn here.
    it("warns once per process, not once per load", async () => {
      writeBag("broken-twice", 'throw new Error("nope");');
      await loadBag("broken-twice");
      await loadBag("broken-twice");
      const warnings = warn.mock.calls.filter(([message]) => String(message).includes('bag "broken-twice" could not load its tools'));
      expect(warnings).toHaveLength(1);
    });
  });

  // Regression. Policy-name qualification turned a trait named after its own
  // bag into `<bag>:<bag>`, so it stopped overriding the auto-trait and the
  // bare name became readwrite with no bounds. `first-response-escalate`
  // depends on this override: its manifest calls `access: read` load-bearing.
  it("keeps a trait named after its bag bare, so it still overrides the auto-trait", async () => {
    const bagDir = join(tmpDir, "escalate");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, "bag.yaml"), `
version: v0.1
name: escalate
description: Escalation
mcp-servers:
  slack: { type: http, url: http://localhost:9999/mcp }
traits:
  escalate:
    description: Deep reads only
    access: read
    namespaces: [datadog]
    bounds: [no-secrets]
  helper:
    description: Qualified as usual
    namespaces: [datadog]
`);
    addSnapshotBag("escalate", { type: "local", path: bagDir });
    const bag = await resolveLoadBag("escalate");

    expect(bag!.traits.map((t) => t.name).sort()).toEqual(["escalate", "escalate:helper"]);
    const main = getAllTraits(bag!).filter((t) => t.name === "escalate");
    expect(main).toHaveLength(1);
    expect(main[0].access).toBe("read");
    expect(main[0].bags).toEqual(["datadog"]);
    expect(main[0].boundNames).toEqual(["no-secrets"]);
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
