import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadRegistry: vi.fn(),
  loadBags: vi.fn(),
  loadAllBags: vi.fn(async () => []),
  bagLoadStamp: vi.fn(() => "stamp-a"),
  checkBagDependencies: vi.fn(() => []),
  bagNeedsInstall: vi.fn(() => false),
}));

const cacheDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  barryCacheDir: () => cacheDir.path,
}));

import { loadRegistry, loadBags, loadAllBags, bagLoadStamp, checkBagDependencies, bagNeedsInstall } from "@barry-rocks/sdk/internal/bags";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Bag, BagManifest } from "@barry-rocks/sdk/bags";
import { resolveBags, resolveAndSyncBags, resolveAndSyncBagsIfChanged, UnregisteredBagError } from "./identity-bags.js";

interface FakeBagOptions {
  subBags?: string[];
  services?: number;
  path?: string;
}

/** A manifest carrying only what these tests read: the sub-bag list. */
function fakeManifest(name: string, bags: string[]): BagManifest {
  return {
    name, description: "", mcpServers: {}, tools: [], dependencies: [],
    services: {}, apps: {}, schedules: {}, scripts: {}, bags,
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
  vi.mocked(checkBagDependencies).mockReturnValue([]);
  vi.mocked(bagNeedsInstall).mockReturnValue(false);
});

describe("resolveBags — sub-bag expansion", () => {
  it("resolves sub-bags without persisting them", async () => {
    withBags([fakeBag("git", { subBags: ["core"] }), fakeBag("core")]);

    const result = await resolveBags(["git"]);

    // Only the explicit ask is stored; composition is resolved at load time.
    expect(result.bags).toEqual(["git"]);
    expect(result.composedBags).toEqual(["git", "core"]);
    expect(result.addedSubBags).toEqual(["core"]);
  });

  it("terminates on a cyclic manifest", async () => {
    withBags([fakeBag("a", { subBags: ["b"] }), fakeBag("b", { subBags: ["a"] })]);

    const result = await resolveBags(["a"], { maxDepth: 10 });

    expect(result.bags).toEqual(["a"]);
    expect(result.composedBags).toEqual(["a", "b"]);
  });

  it("honors maxDepth", async () => {
    withBags([
      fakeBag("a", { subBags: ["b"] }),
      fakeBag("b", { subBags: ["c"] }),
      fakeBag("c"),
    ]);

    expect((await resolveBags(["a"], { maxDepth: 1 })).composedBags).toEqual(["a", "b"]);
    expect((await resolveBags(["a"], { maxDepth: 2 })).composedBags).toEqual(["a", "b", "c"]);
    expect((await resolveBags(["a"], { maxDepth: 2 })).bags).toEqual(["a"]);
  });

  it("warns about an unregistered sub-bag rather than adding it", async () => {
    withBags([fakeBag("git", { subBags: ["ghost"] })]);

    const result = await resolveBags(["git"]);

    expect(result.bags).toEqual(["git"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "unregistered-subbag", bag: "ghost" }),
    );
  });

  it("expands sub-bags only from the loaded closure without loading the rest of the registry", async () => {
    withBags(
      [fakeBag("git", { subBags: ["core"] }), fakeBag("core", { subBags: ["leaf"] }), fakeBag("leaf")],
      [],
      [fakeBag("unrelated")],
    );

    const result = await resolveBags(["git"]);

    expect(result.composedBags).toEqual(["git", "core", "leaf"]);
    expect(loadAllBags).not.toHaveBeenCalled();
  });
});

describe("resolveBags — unregistered bags", () => {
  it("warns and drops unknown names when non-strict", async () => {
    withBags([fakeBag("git")]);

    const result = await resolveBags(["git", "ghost"]);

    expect(result.bags).toEqual(["git"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "unregistered-bag", bag: "ghost" }),
    );
  });

  it("throws with every unknown name when strict", async () => {
    withBags([fakeBag("git")]);

    await expect(resolveBags(["git", "ghost", "phantom"], { strict: true })).rejects.toThrow(
      UnregisteredBagError,
    );
    await expect(resolveBags(["ghost", "phantom"], { strict: true })).rejects.toMatchObject({
      bags: ["ghost", "phantom"],
    });
  });
});

describe("resolveBags — idempotency", () => {
  it("produces an identical result on a second run", async () => {
    withBags([fakeBag("git", { subBags: ["core"] }), fakeBag("core")]);

    const first = await resolveBags(["git"]);
    const second = await resolveBags(first.bags);

    expect(second.bags).toEqual(first.bags);
    expect(second.composedBags).toEqual(first.composedBags);
  });

  it("dedupes repeated names in the input", async () => {
    withBags([fakeBag("git")]);

    expect((await resolveBags(["git", "git"])).bags).toEqual(["git"]);
  });
});

describe("resolveBags — warnings", () => {
  it("aggregates dependency, npm and load warnings together", async () => {
    withBags([fakeBag("git"), fakeBag("temporal")], ["broken"]);
    vi.mocked(checkBagDependencies).mockReturnValue([
      { bag: "temporal", dependency: { name: "temporal", install: "brew install temporal" } },
    ]);
    vi.mocked(bagNeedsInstall).mockImplementation((dir: string) => dir === "/bags/git");

    const result = await resolveBags(["git", "temporal", "broken"]);

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
    vi.mocked(loadBags).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();

    const pending = resolveBags(["git", "slow"]);
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
    expect((await resolveBags(["git"])).timedOut).toBe(false);
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

  it("resolves the first time, then skips while the stamp is unchanged", async () => {
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).toBeNull();
    expect(loadBags).toHaveBeenCalled();
    vi.mocked(loadBags).mockClear();
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(loadBags).not.toHaveBeenCalled();
  });

  it("resolves again when anything the stamp covers changes", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    vi.mocked(bagLoadStamp).mockReturnValue("stamp-b");
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
  });

  it("keeps stamps per key", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(await resolveAndSyncBagsIfChanged("identity-2", ["git"])).not.toBeNull();
  });

  it("resolves regardless when forced", async () => {
    await resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"], { force: true })).not.toBeNull();
  });

  it("does not record a resolution that timed out", async () => {
    vi.mocked(loadBags).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = resolveAndSyncBagsIfChanged("identity-1", ["git"]);
    for (let phase = 0; phase < 3; phase++) await vi.advanceTimersByTimeAsync(11_000);
    expect((await pending)?.timedOut).toBe(true);
    vi.useRealTimers();

    withBags([fakeBag("git")]);
    expect(await resolveAndSyncBagsIfChanged("identity-1", ["git"])).not.toBeNull();
  });

  it("exports resolveAndSyncBags as an alias of resolveBags", () => {
    expect(resolveAndSyncBags).toBe(resolveBags);
  });
});
