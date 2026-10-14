import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `barry install` tells the instance's service management, which starts the new bag's
 * services with no setup rerun. It used to run a launchd setup script
 * instead, which from a worktree unloaded the deployed services.
 * child_process is mocked, so a setup script run would be seen and fail the test.
 */
const spawnSync = vi.fn((..._args: unknown[]) => ({ status: 0 }));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(), spawn: vi.fn(), spawnSync: (...a: unknown[]) => spawnSync(...a) }));

const bagNeedsInstall = vi.fn();
// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would run against the
// real modules.
vi.mock("@barry-rocks/sdk/internal/traits", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/traits")>(),
  expandComposition: vi.fn((n: string[]) => [...n]),
}));
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  discoverBuildableBags: vi.fn(() => []),
  getBuiltBagEntry: vi.fn(() => null),
  bagNeedsInstall: (...a: unknown[]) => bagNeedsInstall(...a),
  checkBagDependencyStates: vi.fn(() => []),
  isBinaryOnPath: vi.fn(() => true),
  loadBag: vi.fn(),
  loadAllBags: vi.fn(async () => []),
  expandCompositionFromSnapshot: vi.fn(async (n: string[]) => [...n]),
  getAllTraits: vi.fn(() => []),
  getRegistrySnapshotPath: vi.fn(() => "/tmp/bags.yaml"),
  isBuiltinBag: vi.fn(() => true),
  getBagSource: vi.fn(),
}));


const parseManifest = vi.fn();
vi.mock("@barry-rocks/sdk/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/bags")>(),
  parseManifest: (...a: unknown[]) => parseManifest(...a),
  resolveBagAccess: vi.fn(() => "enabled"),
}));

vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),
  hasOAuthTokens: vi.fn(() => false),
  getOAuthAccessToken: vi.fn(),
  refreshOAuthToken: vi.fn(),
  isOAuthBag: vi.fn(() => false),
  getDeclaredEnvVars: vi.fn(() => []),
}));


vi.mock("../src/bags/scaffold.js", () => ({
  scaffoldBag: vi.fn(),
}));
vi.mock("../src/bags/scaffold-kinds.js", () => ({
  scaffoldTrait: vi.fn(),
}));

// The identities bag's root, as bag.ts reaches it; nothing on this path calls it.
vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: { list: vi.fn(async () => []), directory: vi.fn() },
  traits: { list: vi.fn(async () => []), ensure: vi.fn(async () => []), syncBags: vi.fn() },
  bounds: {},
}));
const reconcileServices = vi.fn();
vi.mock("../src/commands/service.js", () => ({
  reconcileServices: (...a: unknown[]) => reconcileServices(...a),
  restartManagedService: vi.fn(async () => true),
}));
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(), upsertBag: vi.fn(), listBags: vi.fn(async () => []), deleteBag: vi.fn(),
}));

const { bagInstallCommand } = await import("../src/commands/bag.js");

const setupRuns = () =>
  spawnSync.mock.calls.filter((call) => call[0] === "bash" && String(call[1]).includes("launchd"));

function manifest(items: { services?: object; schedules?: object; apps?: object } = {}) {
  return { name: "sample", description: "", services: {}, schedules: {}, apps: {}, ...items };
}

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  bagNeedsInstall.mockReturnValue(false);
  reconcileServices.mockResolvedValue({ started: ["sample.web"], stopped: [] });
  dir = mkdtempSync(join(tmpdir(), "bag-install-service management-"));
  writeFileSync(join(dir, "bag.yaml"), "name: sample\ndescription: test\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("barry install and the service management", () => {
  it("tells the service management once, and runs no setup script", async () => {
    parseManifest.mockReturnValue(manifest({ services: { web: { command: "node" } } }));
    await bagInstallCommand(dir, {});
    expect(reconcileServices).toHaveBeenCalledTimes(1);
    expect(setupRuns()).toHaveLength(0);
  });

  it("still installs when no service management is running; it reads the bag when it starts", async () => {
    reconcileServices.mockResolvedValue(null);
    parseManifest.mockReturnValue(manifest({ services: { web: { command: "node" } } }));
    await bagInstallCommand(dir, {});
    expect(process.exitCode ?? 0).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/retry `barry service add/);
  });
});
