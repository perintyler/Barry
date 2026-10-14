import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The real modules touch the bag registry on disk and the traits table; both
// are stubbed so these tests exercise resolution logic alone.
// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root would be a SILENT no-op now that identity-bags.ts
// reaches the modules directly: the mock never matches and these tests run
// against the real loader.
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadRegistry: vi.fn(),
  loadBags: vi.fn(),
  loadAllBags: vi.fn(async () => []),
  bagLoadStamp: vi.fn(() => "stamp-a"),
  getAllTraits: vi.fn(),
  checkBagDependencies: vi.fn(() => []),
  bagNeedsInstall: vi.fn(() => false),
}));

// The sync stamp lives in the cache dir; point it at a per-test scratch dir.
const cacheDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  barryCacheDir: () => cacheDir.path,
}));


// `./auto-traits` is deliberately NOT mocked: expandComposition is pure map
// traversal with no I/O, so these tests cover the same composition logic the
// runtime uses. Under the old root mock this needed an importOriginal
// passthrough; a per-subpath mock gets it by simply leaving the module alone.

// The path must match what identity-bags.ts actually imports. It was
// `./traits.js` while both files lived in the identities store; the module now reaches
// traits across the package boundary, and a vi.mock naming a specifier the
// subject never imports silently mocks NOTHING -- the real Traits loads, and
// the failure surfaces far away as "mockResolvedValue is not a function".
vi.mock("../config/traits.js", () => ({
  Traits: {
    assertOwnership: vi.fn(async () => {}),
    ensureTraits: vi.fn(async () => []),
  },
}));

vi.mock("../config/bounds.js", () => ({
  Bounds: {
    assertOwnership: vi.fn(async () => {}),
    upsertBound: vi.fn(),
  },
}));

import { loadRegistry, loadBags, loadAllBags, bagLoadStamp, getAllTraits, checkBagDependencies, bagNeedsInstall } from "@barry-rocks/sdk/internal/bags";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



import type { Bag, BagManifest } from "@barry-rocks/sdk/bags";
import { Traits } from "../config/traits.js";
import { Bounds } from "../config/bounds.js";
import { resolveAndSyncBags, resolveAndSyncBagsIfChanged, UnregisteredBagError } from "./identity-bags.js";

interface FakeBagOptions {
  subBags?: string[];
  services?: number;
  path?: string;
}

/** A manifest carrying only what these tests read: the sub-bag list. */
function fakeManifest(name: string, bags: string[]): BagManifest {
  return {
    name, description: "", mcpServers: {}, tools: [], dependencies: [],
    traits: {}, services: {}, apps: {}, schedules: {}, scripts: {}, bags,
  };
}

function fakeBag(name: string, options: FakeBagOptions = {}): Bag {
  const { subBags = [], services = 0, path = `/bags/${name}` } = options;
  return {
    name,
    description: "",
    builtin: false,
    source: { type: "local", path },
    manifest: subBags.length > 0 ? fakeManifest(name, subBags) : null,
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
    apps: [],
    services: Array.from({ length: services }, (_, i) => ({
      name: `svc${i}`, description: "", command: "tsx", args: [],
    })),
    schedules: [],
  };
}

/**
 * Register `names` and make loadBags return the matching fake bags.
 *
 * `others` are bags that exist in the registry but are NOT part of the
 * requested set — they stand in for the rest of the machine's bags, which
 * `loadAllBags` sees and a per-identity load does not. Trait absorption reads
 * the full registry, so it must observe them.
 */
function withBags(bags: Bag[], extraRegistryNames: string[] = [], others: Bag[] = []): void {
  const registry: Record<string, unknown> = {};
  for (const p of [...bags, ...others]) registry[p.name] = { type: "local", path: `/bags/${p.name}` };
  for (const n of extraRegistryNames) registry[n] = { type: "local", path: `/bags/${n}` };
  vi.mocked(loadRegistry).mockReturnValue(registry as ReturnType<typeof loadRegistry>);
  vi.mocked(loadBags).mockImplementation(async (names: string[]) =>
    names.map((n) => bags.find((p) => p.name === n)).filter((p): p is Bag => Boolean(p)),
  );
  vi.mocked(loadAllBags).mockImplementation(async () => [...bags, ...others]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAllBags).mockResolvedValue([]);
  vi.mocked(getAllTraits).mockReturnValue([]);
  vi.mocked(checkBagDependencies).mockReturnValue([]);
  vi.mocked(bagNeedsInstall).mockReturnValue(false);
  vi.mocked(Traits.assertOwnership).mockResolvedValue(undefined);
  vi.mocked(Bounds.assertOwnership).mockResolvedValue(undefined);
  vi.mocked(Traits.ensureTraits).mockResolvedValue([]);
});

describe("resolveAndSyncBags — sub-bag expansion", () => {
  it("resolves sub-bags without persisting them", async () => {
    withBags([fakeBag("git", { subBags: ["core"] }), fakeBag("core")]);

    const result = await resolveAndSyncBags(["git"]);

    // Only the explicit ask is stored; composition is resolved at load time.
    expect(result.bags).toEqual(["git"]);
    expect(result.composedBags).toEqual(["git", "core"]);
    expect(result.addedSubBags).toEqual(["core"]);
  });

  it("terminates on a cyclic manifest", async () => {
    withBags([fakeBag("a", { subBags: ["b"] }), fakeBag("b", { subBags: ["a"] })]);

    const result = await resolveAndSyncBags(["a"], { maxDepth: 10 });

    expect(result.bags).toEqual(["a"]);
    expect(result.composedBags).toEqual(["a", "b"]);
  });

  it("honors maxDepth", async () => {
    withBags([
      fakeBag("a", { subBags: ["b"] }),
      fakeBag("b", { subBags: ["c"] }),
      fakeBag("c"),
    ]);

    // maxDepth still bounds the closure that drives trait sync and launchd,
    // even though none of it is persisted.
    expect((await resolveAndSyncBags(["a"], { maxDepth: 1 })).composedBags).toEqual(["a", "b"]);
    expect((await resolveAndSyncBags(["a"], { maxDepth: 2 })).composedBags).toEqual(["a", "b", "c"]);
    expect((await resolveAndSyncBags(["a"], { maxDepth: 2 })).bags).toEqual(["a"]);
  });

  it("warns about an unregistered sub-bag rather than adding it", async () => {
    withBags([fakeBag("git", { subBags: ["ghost"] })]);

    const result = await resolveAndSyncBags(["git"]);

    expect(result.bags).toEqual(["git"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "unregistered-subbag", bag: "ghost" }),
    );
  });

  it("registers traits for sub-bags, not just the requested bag", async () => {
    withBags([fakeBag("git", { subBags: ["core"] }), fakeBag("core")]);
    vi.mocked(getAllTraits).mockImplementation((bag: Bag) => [
      { name: bag.name, description: "", access: "readwrite", bags: [bag.name], skills: [], instructions: [], boundNames: [] },
    ]);

    await resolveAndSyncBags(["git"]);

    expect(Traits.ensureTraits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Traits.ensureTraits).mock.calls[0][0].map((t) => t.name)).toEqual(["git", "core"]);
  });
});

describe("resolveAndSyncBags — trait absorption", () => {
  /**
   * The silent-shrink guard.
   *
   * A parent's auto-trait absorbs its sub-bags' namespaces, and getAllTraits
   * can only absorb what the map it receives contains. If that map is built
   * from this barry's bags alone, parent trait rows get rewritten without the
   * children's namespaces the moment composition is not baked into the
   * persisted list — no error, no other failing test, just sessions quietly
   * losing tools. So the map must come from the full registry.
   */
  // Absorption draws on the loaded closure. It used to load the whole
  // registry for this, which added nothing (absorption only walks each bag's
  // own `bags:` closure, all loaded here) but built and imported every
  // installed bag's tool code on every identity CLI command.
  it("absorbs from the loaded closure, including grand-children", async () => {
    withBags(
      [fakeBag("git", { subBags: ["core"] }), fakeBag("core", { subBags: ["leaf"] }), fakeBag("leaf")],
      [],
      // Registered, but not part of this barry's resolved set.
      [fakeBag("unrelated")],
    );

    await resolveAndSyncBags(["git"]);

    const maps = vi.mocked(getAllTraits).mock.calls.map((call) => call[1]);
    expect(maps.length).toBeGreaterThan(0);
    for (const byName of maps) {
      // Every descendant must be visible so the parent can absorb it...
      expect(byName?.has("core")).toBe(true);
      expect(byName?.has("leaf")).toBe(true);
    }
    // ...without paying for the rest of the registry.
    expect(loadAllBags).not.toHaveBeenCalled();
  });
});

describe("resolveAndSyncBags — unregistered bags", () => {
  it("warns and drops unknown names when non-strict", async () => {
    withBags([fakeBag("git")]);

    const result = await resolveAndSyncBags(["git", "ghost"]);

    expect(result.bags).toEqual(["git"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "unregistered-bag", bag: "ghost" }),
    );
  });

  it("throws with every unknown name when strict", async () => {
    withBags([fakeBag("git")]);

    await expect(resolveAndSyncBags(["git", "ghost", "phantom"], { strict: true })).rejects.toThrow(
      UnregisteredBagError,
    );
    await expect(resolveAndSyncBags(["ghost", "phantom"], { strict: true })).rejects.toMatchObject({
      bags: ["ghost", "phantom"],
    });
  });
});

describe("resolveAndSyncBags — idempotency", () => {
  it("produces an identical result and no extra trait rows on a second run", async () => {
    withBags([fakeBag("git", { subBags: ["core"] }), fakeBag("core")]);
    vi.mocked(getAllTraits).mockImplementation((bag: Bag) => [
      { name: bag.name, description: "", access: "read", bags: [bag.name], skills: [], instructions: [], boundNames: [] },
    ]);

    const first = await resolveAndSyncBags(["git"]);
    const second = await resolveAndSyncBags(first.bags);

    expect(second.bags).toEqual(first.bags);
    expect(second.composedBags).toEqual(first.composedBags);
    const [firstCall, secondCall] = vi.mocked(Traits.ensureTraits).mock.calls;
    expect(secondCall[0]).toEqual(firstCall[0]);
  });

  it("dedupes repeated names in the input", async () => {
    withBags([fakeBag("git")]);

    expect((await resolveAndSyncBags(["git", "git"])).bags).toEqual(["git"]);
  });
});

describe("resolveAndSyncBags — warnings", () => {
  it("skipTraitSync writes no traits", async () => {
    withBags([fakeBag("git")]);
    vi.mocked(getAllTraits).mockReturnValue([
      { name: "git", description: "", access: "readwrite", bags: ["git"], skills: [], instructions: [], boundNames: [] },
    ]);

    const result = await resolveAndSyncBags(["git"], { skipTraitSync: true });

    expect(Traits.ensureTraits).not.toHaveBeenCalled();
    expect(Bounds.upsertBound).not.toHaveBeenCalled();
    expect(Traits.assertOwnership).not.toHaveBeenCalled();
    expect(Bounds.assertOwnership).not.toHaveBeenCalled();
    expect(result.syncedTraits).toEqual([]);
  });

  it("aggregates dependency, npm and load warnings together", async () => {
    withBags([fakeBag("git"), fakeBag("temporal")], ["broken"]);
    vi.mocked(checkBagDependencies).mockReturnValue([
      { bag: "temporal", dependency: { name: "temporal", install: "brew install temporal" } },
    ]);
    vi.mocked(bagNeedsInstall).mockImplementation((dir: string) => dir === "/bags/git");

    const result = await resolveAndSyncBags(["git", "temporal", "broken"]);

    expect(result.warnings.map((w) => w.kind).sort()).toEqual([
      "bag-load-failed",
      "missing-dependency",
      "npm-not-installed",
    ]);
    expect(result.warnings.find((w) => w.kind === "missing-dependency")?.hint).toBe(
      "brew install temporal",
    );
  });

  it("reports a load timeout without losing the bags that did resolve", async () => {
    withBags([fakeBag("git")], ["slow"]);
    // loadBags stalls past the 10s ceiling; fake timers let the race resolve
    // on the timeout branch without the test actually waiting.
    vi.mocked(loadBags).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();

    const pending = resolveAndSyncBags(["git", "slow"]);
    // Sub-bag expansion, the main load and the removal check each arm their
    // own timeout, so the clock has to be run forward once per phase.
    for (let phase = 0; phase < 3; phase++) await vi.advanceTimersByTimeAsync(11_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result.bags).toEqual(["git", "slow"]);
    expect(result.warnings.filter((w) => w.kind === "bag-load-failed").map((w) => w.bag)).toEqual([
      "git",
      "slow",
    ]);
    expect(result.timedOut).toBe(true);
  });

  it("reports no timeout when every load completes", async () => {
    withBags([fakeBag("git")]);
    expect((await resolveAndSyncBags(["git"])).timedOut).toBe(false);
  });
});

describe("resolveAndSyncBagsIfChanged", () => {
  beforeEach(() => {
    cacheDir.path = mkdtempSync(join(tmpdir(), "bag-sync-stamp-"));
    vi.mocked(bagLoadStamp).mockReturnValue("stamp-a");
    withBags([fakeBag("git")]);
  });

  afterEach(() => {
    rmSync(cacheDir.path, { recursive: true, force: true });
  });

  it("syncs the first time, then skips while the stamp is unchanged", async () => {
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).toBeNull();
    expect(loadBags).toHaveBeenCalled();
    vi.mocked(loadBags).mockClear();
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(loadBags).not.toHaveBeenCalled();
  });

  it("syncs again when anything the stamp covers changes", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    vi.mocked(bagLoadStamp).mockReturnValue("stamp-b");
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
  });

  it("keeps stamps per key", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(await resolveAndSyncBagsIfChanged("identity-2", ["git"])).not.toBeNull();
  });

  it("syncs regardless when forced", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"], { force: true })).not.toBeNull();
  });

  // A timed-out sync reflects fewer bags than were asked for. Recording it
  // would skip the retry that would have completed it.
  it("does not record a sync that timed out", async () => {
    vi.mocked(loadBags).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    for (let phase = 0; phase < 3; phase++) await vi.advanceTimersByTimeAsync(11_000);
    expect((await pending)?.timedOut).toBe(true);
    vi.useRealTimers();

    withBags([fakeBag("git")]);
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
  });

  it("does not record a sync that threw", async () => {
    vi.mocked(Traits.ensureTraits).mockRejectedValueOnce(new Error("db locked"));
    vi.mocked(getAllTraits).mockReturnValue([
      { name: "git", description: "", access: "readwrite", bags: ["git"], skills: [], instructions: [], boundNames: [] },
    ]);
    await expect(resolveAndSyncBagsIfChanged("identity-1", ["git"])).rejects.toThrow("db locked");
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
  });
});


describe("resolveAndSyncBags — ownership validation", () => {
  function withOwnedDefinitions(): void {
    const bag = fakeBag("git", { subBags: ["core"] });
    bag.manifest!.bounds = {
      "git:read-only": { description: "Read only", bound: { bash: { deny: ["rm"] } } },
    };
    withBags([bag, fakeBag("core")]);
    vi.mocked(getAllTraits).mockImplementation((loadedBag: Bag) => [
      { name: loadedBag.name, description: "", access: "read", bags: [loadedBag.name], skills: [], instructions: [], boundNames: [] },
    ]);
  }

  it("validates owning bags before syncing bounds and composed traits", async () => {
    withOwnedDefinitions();

    await resolveAndSyncBags(["git"]);

    expect(Traits.assertOwnership).toHaveBeenCalledWith([
      { name: "git", bag: "git" },
      { name: "core", bag: "core" },
    ]);
    expect(Bounds.assertOwnership).toHaveBeenCalledWith([{ name: "git:read-only", bag: "git" }]);
    expect(Bounds.upsertBound).toHaveBeenCalledWith({
      name: "git:read-only", description: "Read only", bound: { bash: { deny: ["rm"] } }, bag: "git",
    });
    expect(vi.mocked(Bounds.assertOwnership).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Bounds.upsertBound).mock.invocationCallOrder[0]);
    expect(vi.mocked(Traits.assertOwnership).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Traits.ensureTraits).mock.invocationCallOrder[0]);
  });

  it.each(["traits", "bounds"])("propagates %s ownership conflicts without writing definitions", async (kind) => {
    withOwnedDefinitions();
    const conflict = new Error(`${kind} already owned by another bag`);
    const ownership = kind === "traits" ? Traits.assertOwnership : Bounds.assertOwnership;
    vi.mocked(ownership).mockRejectedValue(conflict);

    await expect(resolveAndSyncBags(["git"])).rejects.toThrow(conflict);

    expect(Bounds.upsertBound).not.toHaveBeenCalled();
    expect(Traits.ensureTraits).not.toHaveBeenCalled();
  });
});

it("carries native grants through bag synchronization", async () => {
  withBags([fakeBag("claude")]);
  vi.mocked(getAllTraits).mockReturnValue([{ name: "claude:native-file-reads", description: "Native reads", access: "read", bags: [], skills: [], instructions: [], boundNames: [], nativeTools: { "claude-code": ["Read", "Glob", "Grep"] } }]);
  await resolveAndSyncBags(["claude"]);
  expect(Traits.ensureTraits).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "claude:native-file-reads", nativeTools: { "claude-code": ["Read", "Glob", "Grep"] } })]), expect.anything());
});
