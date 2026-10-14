import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../src/lib/cli-error.js";
import { Barry, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";

/**
 * Unit-level rather than subprocess-level (unlike the rest of cli/test): the
 * behaviors that matter here — that traits get synced, that sub-bag traits get
 * synced too, that launchd is left alone — are side effects on collaborators,
 * which a spawned `barry bag enable` cannot observe.
 */
const { mockSpawnSync, mockExistsSync, mockUnlinkSync, mockReaddirSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(() => ({ status: 0 })),
  mockExistsSync: vi.fn(() => false),
  mockUnlinkSync: vi.fn(),
  mockReaddirSync: vi.fn(() => [] as string[]),
}));

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(), spawn: vi.fn(), spawnSync: mockSpawnSync }));
vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: vi.fn(() => ""),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  unlinkSync: mockUnlinkSync,
}));

// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would run against the
// real modules.
vi.mock("@barry-rocks/sdk/internal/traits", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/traits")>(),
  expandComposition: vi.fn((names: string[]) => [...names]),
}));
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  isBinaryOnPath: vi.fn(() => true),
  bagNeedsInstall: vi.fn(() => false),
  loadBag: vi.fn(),
  loadBagSync: vi.fn(() => ({ name: "git", source: { type: "local", path: "/bags/git" }, manifest: { stores: {} } })),
  loadAllBags: vi.fn(async () => []),
  expandCompositionFromSnapshot: vi.fn(async (names: string[]) => [...names]),
  getAllTraits: vi.fn(() => []),
  loadRegistry: vi.fn(() => ({
    git: { type: "local", path: "/bags/git" },
    reminders: { type: "local", path: "/bags/reminders" },
  })),
  isBuiltinBag: vi.fn(() => true),
  getBagSource: vi.fn(() => ({ type: "local", path: "/bags/git" })),
}));
// Identities here are directory-backed unless a test says otherwise: pack and
// unpack refuse an identity without an identity.yaml.
const mockIdentityDir = vi.hoisted(() => vi.fn((_ref: { name: string }): string | null => "/identities/work"));


vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),
  hasOAuthTokens: vi.fn(() => false),
  isOAuthBag: vi.fn(() => false),
  getDeclaredEnvVars: vi.fn(() => []),
}));

vi.mock("../src/bags/scaffold.js", () => ({
  scaffoldBag: vi.fn(),
}));
vi.mock("@barry-rocks/sdk/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/bags")>(),
  resolveBagAccess: vi.fn(() => "enabled"),
}));

// The identities bag's root, as bag.ts reaches it: an identity's directory,
// the owner's identities (for --unregister), and the bag sync pack runs.
const roots = vi.hoisted(() => ({
  list: vi.fn(async () => [] as Array<{ record: { name: string; metadata: { bags?: string[] } } }>),
  syncBags: vi.fn(),
  /** The identity requireIdentity finds by name, until an update replaces it. */
  named: vi.fn(),
}));
vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: { directory: mockIdentityDir, list: roots.list },
  traits: { list: vi.fn(async () => []), ensure: vi.fn(async () => []), syncBags: roots.syncBags },
  bounds: {},
}));

// pack() gates on installBlockers, which asks the registry whether the bag is
// registered and on disk. Default to "installed" so the membership tests below
// exercise packing rather than the gate; the gate has its own test.
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(async (name: string) => ({
    name,
    source: { type: "remote", url: "https://example.test/mcp" },
    builtin: false,
  })),
  upsertBag: vi.fn(),
  deleteBag: vi.fn(async () => true),
  listBags: vi.fn(async () => []),
  writeRegistrySnapshot: vi.fn(async () => "/tmp/snapshot.json"),
}));

vi.mock("../src/lib/current-user.js", () => ({
  getCurrentUser: vi.fn(async () => ({ id: 1, settings: {} })),
  getActiveIdentity: vi.fn(() => "default"),
}));

vi.mock("../src/commands/service.js", () => ({
  restartManagedService: vi.fn(async () => true),
  reconcileServices: vi.fn(async () => ({ started: [], stopped: [] })),
}));

// pack/unpack read the identity through identity.js (directory first) and
// change it through `Barry`. Faked here as one in-memory identity: seeded from
// whatever a test hands `roots.named`, then replaced by what an update writes
// — so the commands' re-read after writing sees the write, as it would on disk.
// That the write really reaches identity.yaml is pack-identity-file.test.ts's job.
type FakeIdentity = { id: number; name: string; actor_id: number; metadata: Record<string, unknown> };
const identityState = vi.hoisted(() => ({ written: undefined as undefined | FakeIdentity }));
vi.mock("../src/commands/identity.js", () => ({
  requireIdentity: vi.fn(async (name: string) => ({
    user: { id: 1, settings: {} },
    identity: identityState.written ?? (await roots.named(name)),
    dir: "/identities/work",
    source: "file",
  })),
}));

import {
  bagPackCommand,
  packBag,
  bagUnpackCommand,
  identityInstallCommand,
} from "../src/commands/bag.js";
import type { ResolveBagsResult } from "@barry-rocks/identities-bag";
import { reconcileServices } from "../src/commands/service.js";
import { identityFixture } from "./helpers/identity-fixture.js";

const mockResolve = roots.syncBags;
const mockNamed = roots.named;
const mockReconcileSupervisor = vi.mocked(reconcileServices);
/** What pack and unpack write: `Barry.identity(name).update(changes)`, as the identities subject receives it. */
const mockUpdate = vi.fn<Identities["update"]>(async (ref, changes) => {
  const current: FakeIdentity = identityState.written ?? (await mockNamed(ref));
  identityState.written = { ...current, metadata: { ...current.metadata, ...changes } };
  return { ...identityFixture(String(ref)), warnings: [] };
});

function resolvedTo(overrides: Partial<ResolveBagsResult> = {}): ResolveBagsResult {
  return {
    bags: [],
    composedBags: [],
    addedSubBags: [],
    syncedTraits: [],
    warnings: [],
    timedOut: false,
    ...overrides,
  };
}

function barryWithBags(bags: string[]) {
  return { id: 1, name: "default", actor_id: 1, metadata: { bags: bags } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  identityState.written = undefined;
  Barry.use(fakeIdentities({ update: mockUpdate }));
  // clearAllMocks wipes the factory implementations too, so getBag would return
  // undefined and every pack test would trip the "not registered" blocker
  // rather than the branch it means to exercise. Restore a sane default.
  const { getBag, deleteBag } = await import("../src/bags/registration.js");
  vi.mocked(getBag).mockResolvedValue({
    name: "default",
    source: { type: "remote", url: "https://example.test/mcp" },
    builtin: false,
  });
  vi.mocked(deleteBag).mockResolvedValue(true);
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => Barry.reset());

// Services are now managed by the service management, not launchd — no worktree guard needed.

describe("barry bag enable", () => {
  it("still syncs traits when the bag is already enabled", async () => {
    // The repair path: re-running enable is how missing trait rows get fixed,
    // so resolution must happen before the idempotency short-circuit.
    mockNamed.mockResolvedValue(barryWithBags(["git"]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"], syncedTraits: ["git", "git-read"] }));

    await bagPackCommand("git", {});

    expect(mockResolve).toHaveBeenCalledWith(["git"]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("persists only the requested bag, not its sub-bags", async () => {
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(
      resolvedTo({ bags: ["git"], composedBags: ["git", "core"], addedSubBags: ["core"] }),
    );

    await bagPackCommand("git", {});

    // `core` is reached through git's composition at load time, so storing it
    // would freeze the manifest and strand it when git is unpacked.
    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
  });

  it("leaves no orphaned sub-bag behind when a parent is unpacked", async () => {
    mockNamed.mockResolvedValue(barryWithBags(["git"]));

    await bagUnpackCommand("git", {});

    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: [] }, expect.anything());
  });

  it("does not run launchd setup for a bag without services", async () => {
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"] }));

    await bagPackCommand("git", {});

    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("leaves services alone, even for a bag declaring them", async () => {
    // The service management runs REGISTERED bags' services; packing changes nothing it
    // reads, so asking it to reconcile here would only apply unrelated pending
    // changes. install owns that.
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["reminders"] }));
    mockExistsSync.mockReturnValue(true);

    await bagPackCommand("reminders", {});

    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["reminders"] }, expect.anything());
    expect(mockReconcileSupervisor).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("not installed"));
  });

});
// The warning about uninstalled services was removed: the service management reconciles
// on install, and pack does not touch services at all.

describe("barry bag disable", () => {
  it("removes the bag but leaves its services, which follow registration", async () => {
    // Another identity may still pack it; stopping its services here would
    // stop them for everyone.
    mockNamed.mockResolvedValue(barryWithBags(["git", "reminders"]));
    mockExistsSync.mockReturnValue(true);

    await bagUnpackCommand("reminders", {});

    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
    expect(mockReconcileSupervisor).not.toHaveBeenCalled();
  });
});

describe("barry pack", () => {
  it("adds the bag to the named barry", async () => {
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"], syncedTraits: ["git", "git-read"] }));

    await bagPackCommand("git", { name: "work" });

    expect(mockNamed).toHaveBeenCalledWith("work");
    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
  });

  it("still syncs traits when the bag is already on the barry", async () => {
    // Same repair invariant as the enable alias: resolution has to run before
    // the idempotency short-circuit or drifted trait rows never get fixed.
    mockNamed.mockResolvedValue(barryWithBags(["git"]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"], syncedTraits: ["git", "git-read"] }));

    await bagPackCommand("git", { name: "work" });

    expect(mockResolve).toHaveBeenCalledWith(["git"]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not reconcile services for a bag declaring them", async () => {
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["reminders"] }));
    mockExistsSync.mockReturnValue(true);

    await bagPackCommand("reminders", { name: "work" });

    expect(mockReconcileSupervisor).not.toHaveBeenCalled();
  });
});

describe("barry unpack", () => {
  it("removes the bag and keeps its services", async () => {
    mockNamed.mockResolvedValue(barryWithBags(["git", "reminders"]));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["com.barry.bag.reminders.web.plist"]);

    await bagUnpackCommand("reminders", { name: "work" });

    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("reconciles the service management on --unregister to stop removed services", async () => {
    // The service management stops services for bags no longer in the registry — no
    // plist cleanup needed, since there are no plists.
    const { deleteBag } = await import("../src/bags/registration.js");
    mockNamed.mockResolvedValue(barryWithBags(["git", "reminders"]));
    mockExistsSync.mockReturnValue(true);

    await bagUnpackCommand("reminders", { name: "work", unregister: true });

    expect(vi.mocked(deleteBag)).toHaveBeenCalledWith("reminders");
    expect(mockReconcileSupervisor).toHaveBeenCalled();
  });

  it("leaves the barry alone when the bag is not on it", async () => {
    mockNamed.mockResolvedValue(barryWithBags(["git"]));

    await bagUnpackCommand("reminders", { name: "work" });

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

/**
 * The aliases exist so old muscle memory keeps working — if they ever diverge
 * from the primary spelling in what they write, the rename has leaked.
 */

describe("pack refuses an uninstalled bag", () => {
  it("fails early, pointing at the identity's install, when the bag is not registered", async () => {
    const { getBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValueOnce(null);

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(bagPackCommand("nope", {})).rejects.toThrow(/Bag 'nope' is not installed\. Install it with: \S+ install <path-or-url>/);
    expect(mockUpdate).not.toHaveBeenCalled();

    exit.mockRestore();
    err.mockRestore();
    vi.mocked(getBag).mockReset();
  });

  // Installing is system-level and separate; pack only ever adds an installed
  // bag. It used to offer an install itself, which blurred the two.
  it("never offers to install, even on a terminal", async () => {
    const { getBag, upsertBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValueOnce(null);
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(bagPackCommand("newbag", { name: "work" })).rejects.toThrow(/work install <path-or-url>/);
      expect(vi.mocked(upsertBag)).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
      exit.mockRestore();
      err.mockRestore();
      vi.mocked(getBag).mockReset();
    }
  });
});

describe("pack and unpack need an identity.yaml", () => {
  it.each([
    ["pack", () => bagPackCommand("git", { name: "work" })],
    ["unpack", () => bagUnpackCommand("git", { name: "work" })],
  ])("%s refuses an identity defined only by its DB row", async (_label, run) => {
    mockNamed.mockResolvedValue(barryWithBags(["git"]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"] }));
    mockIdentityDir.mockReturnValueOnce(null);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run()).rejects.toThrow(/has no identity\.yaml/);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});

describe("<identity> install", () => {
  // The system-level install has its own coverage; these test what the
  // identity's install adds on top of it.
  const install = vi.fn(async () => "git");
  beforeEach(() => install.mockClear());

  it("installs, then packs when the answer is yes", async () => {
    const { getBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValue({ name: "git", source: { type: "remote", url: "https://example.com/mcp" }, builtin: false });
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"] }));
    const prompt = vi.fn(async () => true);

    await identityInstallCommand("https://example.com/mcp", { as: "git", prompt, install });

    expect(install).toHaveBeenCalledWith("https://example.com/mcp", expect.objectContaining({ as: "git" }));
    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/Pack "git" onto \S+\?/));
    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
    vi.mocked(getBag).mockReset();
  });

  it("installs without packing when the answer is no", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await identityInstallCommand("https://example.com/mcp", { as: "git", prompt: async () => false, install });
      expect(install).toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(" ")).toMatch(/Pack it with: \S+ pack git/);
    } finally {
      log.mockRestore();
    }
  });

  it("packs without asking under --yes", async () => {
    const { getBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValue({ name: "git", source: { type: "remote", url: "https://example.com/mcp" }, builtin: false });
    mockNamed.mockResolvedValue(barryWithBags([]));
    mockResolve.mockResolvedValue(resolvedTo({ bags: ["git"] }));
    const prompt = vi.fn(async () => false);

    await identityInstallCommand("https://example.com/mcp", { as: "git", yes: true, prompt, install });

    expect(prompt).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: ["git"] }, expect.anything());
    vi.mocked(getBag).mockReset();
  });
});

describe("unpack leaves files alone", () => {
  it("does not delete the bag from the registry by default", async () => {
    const { deleteBag } = await import("../src/bags/registration.js");
    mockNamed.mockResolvedValue(barryWithBags(["git"]));

    await bagUnpackCommand("git", { name: "work" });

    // Membership is removed; the registry entry (and the files) survive.
    expect(mockUpdate).toHaveBeenCalledWith("default", { bags: [] }, expect.anything());
    expect(vi.mocked(deleteBag)).not.toHaveBeenCalled();
  });

  it("keeps the registry entry when another barry still packs it", async () => {
    const { deleteBag } = await import("../src/bags/registration.js");
    mockNamed.mockResolvedValue(barryWithBags(["git"]));
    roots.list.mockResolvedValueOnce([{ record: { name: "other", metadata: { bags: ["git"] } } }]);

    await bagUnpackCommand("git", { name: "work", unregister: true });

    expect(vi.mocked(deleteBag)).not.toHaveBeenCalled();
  });
});

describe("pack gate: local bags", () => {
  // The default getBag mock returns a REMOTE bag, for which installBlockers
  // early-returns — so without overriding it here every local-source branch
  // (path missing, deps, build, disabled) is unreachable and the gate tests
  // are vacuous.
  it("blocks a local bag whose path is gone", async () => {
    const { getBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValueOnce({
      name: "ghost",
      source: { type: "local", path: "/nonexistent/ghost" },
      builtin: false,
    });

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(bagPackCommand("ghost", {})).rejects.toThrow(/does not exist/);
    expect(mockUpdate).not.toHaveBeenCalled();

    exit.mockRestore();
    err.mockRestore();
  });

  // Builtin path resolution is covered in sdk/src/bags/__tests__/builtin.test.ts.
  // Historical acceptance rationale: docs/decisions/0027-regression-evidence-boundaries.md.

  // NOTE: the disabled-bag blocker is deliberately NOT unit-tested here.
  // This file mocks @barry-rocks/sdk/bags wholesale, so resolveBagAccess — which the
  // blocker calls — is a stub, and any assertion would test the stub rather
  // than the gate. Verified end-to-end instead:
  //   barry install <url> --as x && barry bag access x disabled && barry pack x
  //   → Cannot pack "x" — it is not installed:
  //       ✗ "x" is disabled in the registry (barry bag access x enabled)
});
