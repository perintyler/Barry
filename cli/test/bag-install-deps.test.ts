import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../src/lib/cli-error.js";

// The unit under test decides success by measuring node_modules, so the two
// things it consults — the pnpm exit code and bagNeedsInstall — are the two
// things these tests drive.
const spawnSync = vi.fn();
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(), spawnSync: (...a: unknown[]) => spawnSync(...a) }));

const bagNeedsInstall = vi.fn();
// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would run against the
// real modules.
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  discoverBuildableBags: vi.fn(() => []),
  getBuiltBagEntry: vi.fn(() => null),
  bagNeedsInstall: (...a: unknown[]) => bagNeedsInstall(...a),
  checkBagDependencyStates: vi.fn(() => []),
  mcpServerPath: vi.fn(() => "/usr/bin"),
  MCP_SERVER_LABEL: "com.barry.mcp.barry",
  isBinaryOnPath: vi.fn(() => true),
  loadBag: vi.fn(),
  loadAllBags: vi.fn(async () => []),
  expandCompositionFromSnapshot: vi.fn(async (n: string[]) => [...n]),
  getRegistrySnapshotPath: vi.fn(() => "/tmp/bags.yaml"),
  isBuiltinBag: vi.fn(() => true),
  getBagSource: vi.fn(),
}));


vi.mock("@barry-rocks/sdk/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/bags")>(),
  parseManifest: vi.fn(() => null),
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
  scaffoldBound: vi.fn(),
}));

// The identities bag's root, as bag.ts reaches it; nothing on this path calls it.
vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: { list: vi.fn(async () => []), directory: vi.fn() },
  resolveBags: vi.fn(),
}));
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(), upsertBag: vi.fn(), listBags: vi.fn(async () => []), deleteBag: vi.fn(),
}));

const { installBagDependencies } = await import("../src/commands/bag.js");

describe("installBagDependencies decides by measuring, not by exit code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // A nonzero dependency-install exit does not imply missing packages; verify the installed result.
  // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-034
  it("continues when pnpm exits nonzero but the dependencies landed", () => {
    bagNeedsInstall.mockReturnValueOnce(true).mockReturnValueOnce(false);
    spawnSync.mockReturnValue({ status: 1 });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => installBagDependencies("/bags/x")).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    // The unapproved build script is surfaced rather than swallowed.
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("approve-builds");
  });

  it("still fails when the dependencies are genuinely missing", () => {
    bagNeedsInstall.mockReturnValue(true); // before AND after — nothing landed
    spawnSync.mockReturnValue({ status: 1 });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => installBagDependencies("/bags/x")).toThrow(CliError);
    expect(() => installBagDependencies("/bags/x")).toThrow("missing dependencies");
  });

  it("skips pnpm entirely when node_modules is already present", () => {
    bagNeedsInstall.mockReturnValue(false);
    installBagDependencies("/bags/x");
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
