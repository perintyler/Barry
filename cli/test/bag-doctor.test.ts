/**
 * Tests for `barry bag doctor`.
 *
 * The command had no coverage at all, which is how it kept reporting a
 * cache-staleness artifact ("declares sub-bag X which is not enabled") as a
 * broken bag. The first case below pins the deletion of that check: it fails
 * against the old implementation and passes against composition-at-load-time.
 *
 * Unit-level rather than through the CLI subprocess, matching bag.test.ts —
 * doctor touches the config store, launchd, and the bag registry, none of
 * which a test should require.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Barry, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { resolveIdentityConfig, type IdentityDefinition } from "@barry-rocks/sdk/internal/identities";
import type { AnyToolDefinition } from "@barry-rocks/sdk/tools";
import { serviceRegistryPath } from "@barry-rocks/sdk/services";

const { mockExistsSync, mockReaddirSync, mockReadFileSync, dependencyStates, mockSupervisorRequest, MockServiceManagementError } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((_path: unknown) => false),
  mockReaddirSync: vi.fn(() => [] as string[]),
  mockReadFileSync: vi.fn(() => ""),
  /** Per-dependency state a test wants doctor to see. Default is "ok". */
  dependencyStates: new Map<string, { state: string; resolvedPath?: string }>(),
  /** Mock serviceRequest — default throws (no service management). */
  mockSupervisorRequest: vi.fn(),
  /** A fake error class tests can throw / check instanceof. */
  MockServiceManagementError: class MockServiceManagementError extends Error {
    override name = "ServiceManagementError";
  },
}));

vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 0, size: 0 })),
  // The service PATH names this node by its stable link; any path will do here.
  realpathSync: vi.fn((path: string) => path),
}));

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(), spawn: vi.fn(), spawnSync: vi.fn(() => ({ status: 0 })) }));

// Mocked so a test can place the home directory somewhere it controls. The
// subject must resolve the home directory through this and NOT through
// process.env.HOME, which is unset under launchd, `sudo` and `env -i`.
vi.mock("os", async (importOriginal) => ({
  ...await importOriginal<typeof import("os")>(), homedir: vi.fn(() => "/Users/tester") }));

interface FakeDependency {
  optional?: boolean;
  name: string;
  install?: string;
  reason?: string;
}

interface FakeBag {
  name: string;
  manifest: { name?: string; extends?: string; bags?: string[]; toolsEntry?: { env?: string[] } } | null;
  services: Array<{ name: string; user?: string }>;
  source: { type: string; path: string };
  mcpServers: Record<string, { url?: string }>;
  tools: Array<{ toolName?: string; namespace: string }>;
  dependencies: FakeDependency[];
}

const bags = new Map<string, FakeBag>();
const definitions = new Map<string, AnyToolDefinition[]>();
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagToolDefinitions: async (bag: { name: string }) => definitions.get(bag.name),
  isBinaryOnPath: vi.fn(() => true),
  checkBagDependencyStates: vi.fn((bag: FakeBag) =>
    (bag.dependencies ?? []).map((dependency) => ({
      dependency,
      ...(dependencyStates.get(dependency.name) ?? { state: "ok" as const }),
    })),
  ),
  bagNeedsInstall: vi.fn(() => false),
  loadBag: vi.fn((name: string) => bags.get(name) ?? null),
  loadAllBags: vi.fn(async () => [...bags.values()]),
  expandCompositionFromSnapshot: vi.fn(async (names: string[]) => [...names]),
  loadBagSync: vi.fn(),
  getInvalidManifests: vi.fn(() => new Map<string, string>()),
  collectProvidedNamespaces: vi.fn(() => new Set<string>()),
  collectDeclaredMcpServers: vi.fn(() => []),
  findServerKeyConflicts: vi.fn(() => []),
  findEndpointDuplicates: vi.fn(() => []),
  getAllTraits: vi.fn((bag: FakeBag) => [{ name: bag.name }]),
  getRegistrySnapshotPath: vi.fn(() => "/tmp/snapshot.json"),
  loadRegistry: vi.fn(() =>
    Object.fromEntries([...bags.keys()].map((n) => [n, { type: "local", path: `/bags/${n}` }])),
  ),
  isBuiltinBag: vi.fn(() => false),
  getBagSource: vi.fn((name: string) => ({ type: "local", path: `/bags/${name}` })),
  checkBagRequirements: vi.fn(() => []),
}));

function fakeBag(name: string, subBags?: string[]): FakeBag {
  return {
    name,
    manifest: subBags ? { bags: subBags } : {},
    services: [],
    source: { type: "local", path: `/bags/${name}` },
    // The OAuth health scan iterates this on every bag.
    mcpServers: {},
    tools: [],
    dependencies: [],
  };
}

// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would run against the
// real modules.
vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  parseActionFile: vi.fn(),
  listAllActions: vi.fn(async () => []),
}));
vi.mock("@barry-rocks/sdk/internal/traits", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/traits")>(),
  expandComposition: vi.fn((names: string[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      queue.push(...(bags.get(n)?.manifest?.bags ?? []));
    }
    while (queue.length) {
      const n = queue.shift() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      if (!bags.has(n)) continue;
      out.push(n);
      queue.push(...(bags.get(n)?.manifest?.bags ?? []));
    }
    return out;
  }),
  resolveComposedNamespaces: vi.fn(() => new Set<string>()),
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
  scaffoldActionDir: vi.fn(),
  scaffoldInstruction: vi.fn(),
  scaffoldTrait: vi.fn(),
}));


const identities: Array<{ id: number; name: string; metadata: IdentityDefinition }> = [];
const traitRows: Array<{ name: string; namespaces: string[] }> = [];
/** What `--fix` writes: `Barry.identity(name).update(changes)`, which the identities subject receives. */
const update = vi.fn<Identities["update"]>(async (ref) => ({ ...identityFixture(String(ref)), warnings: [] }));
const syncBags = vi.hoisted(() => vi.fn());

vi.mock("@barry-rocks/identities-bag", () => ({
  owner: { current: vi.fn(async () => ({ id: 1 })) },
  identityRecords: {
    list: vi.fn(async () => identities.map((record) => ({ record, source: "file", dir: null, isDefault: false }))),
    config: (identity: { metadata: IdentityDefinition }) => resolveIdentityConfig(identity.metadata),
  },
  traits: {
    list: vi.fn(async () => traitRows),
    orphaned: vi.fn(async () => []),
    syncBags,
  },
  // Doctor reports traits naming a scope that no longer exists. An empty list
  // here means "no scopes known", which that check treats as a failed scope
  // load and skips — so these cases exercise the rest of doctor unchanged.
  bounds: {
    list: vi.fn(async () => []),
  },
}));
// Registry preparation is covered by setup/first-run tests; these doctor
// cases deliberately stub filesystem reads and inspect diagnostic behavior.
vi.mock("../src/services/barry.js", () => ({ prepareBagRegistry: vi.fn(async () => {}) }));
vi.mock("../src/bags/registration.js", () => ({
  upsertBag: vi.fn(),
  deleteBag: vi.fn(),
  getBag: vi.fn(),
  listBags: vi.fn(async () => []),
  writeRegistrySnapshot: vi.fn(async () => "/tmp/snapshot.json"),
}));

vi.mock("../src/commands/service.js", () => ({
  restartManagedService: vi.fn(async () => true),
  reconcileServices: vi.fn(async () => ({ started: [], stopped: [] })),
}));
vi.mock("@barry-rocks/mcp-bag", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/mcp-bag")>(),
  serviceRequest: mockSupervisorRequest,
  ServiceManagementError: MockServiceManagementError,
}));

import { bagDoctorCommand } from "../src/commands/bag.js";
import { identityFixture } from "./helpers/identity-fixture.js";

let output: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  Barry.use(fakeIdentities({ update }));
  bags.clear();
  definitions.clear();
  identities.length = 0;
  traitRows.length = 0;
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Bag directories must look present, or every bag reports "path does not
  // exist" and short-circuits before the checks under test.
  mockExistsSync.mockImplementation((p: unknown) => String(p).startsWith("/bags/"));
  mockReaddirSync.mockReturnValue([]);
  mockReadFileSync.mockReturnValue("");
  dependencyStates.clear();
  process.exitCode = 0;
  // Default: no service management running. Tests that want a running service management
  // override this to return { service management: {}, services: [...] }.
  mockSupervisorRequest.mockRejectedValue(new MockServiceManagementError("no service management"));
  syncBags.mockResolvedValue({
    bags: [],
    composedBags: [],
    addedSubBags: [],
    syncedTraits: [],
    warnings: [],
  });
});

afterEach(() => {
  Barry.reset();
  vi.restoreAllMocks();
});

function text(): string {
  return output.join("\n");
}

describe("bag doctor — sub-bag composition", () => {
  /**
   * The regression this refactor exists to prevent.
   *
   * `browser` declares playwright/chrome/web-fetching but packs none of them.
   * That used to be reported as three errors whose only fix was a re-pack;
   * composition now resolves at load time, so it is the correct steady state.
   */
  it("does not report a declared sub-bag that is absent from the packed list", async () => {
    bags.set("browser", fakeBag("browser", ["playwright"]));
    bags.set("playwright", fakeBag("playwright"));
    identities.push({ id: 1, name: "bux", metadata: { bags: ["browser"] } });
    traitRows.push({ name: "browser", namespaces: [] }, { name: "playwright", namespaces: [] });

    await bagDoctorCommand({});

    expect(text()).not.toContain("not enabled");
    expect(text()).not.toContain("declares sub-bag");
  });

  /**
   * A bag can be explicitly packed AND reachable via a parent's composition.
   * Neither fact makes the other wrong, so doctor stays silent: an explicit
   * pack is a statement of intent, and reporting it would invite unpacking
   * something the user deliberately asked for.
   */
  it("says nothing about a bag that is both packed and composed", async () => {
    bags.set("browser", fakeBag("browser", ["playwright"]));
    bags.set("playwright", fakeBag("playwright"));
    identities.push({ id: 1, name: "bux", metadata: { bags: ["browser", "playwright"] } });
    traitRows.push({ name: "browser", namespaces: [] }, { name: "playwright", namespaces: [] });

    await bagDoctorCommand({});

    expect(text()).not.toContain("redundant");
    expect(text()).not.toContain("already active via");
    expect(text()).not.toContain('bag "playwright"');
  });

  it("never drops an explicitly packed bag under --fix", async () => {
    bags.set("browser", fakeBag("browser", ["playwright"]));
    bags.set("playwright", fakeBag("playwright"));
    identities.push({ id: 1, name: "bux", metadata: { bags: ["browser", "playwright"] } });
    traitRows.push({ name: "browser", namespaces: [] }, { name: "playwright", namespaces: [] });

    await bagDoctorCommand({ fix: true });

    // The pack survives: if `browser` later stops composing playwright, the
    // explicit entry is what keeps it working.
    const wrote = update.mock.calls.find((c) => c[1].bags !== undefined);
    if (wrote) expect(wrote[1].bags).toContain("playwright");
  });
});

describe("bag doctor — checks that must survive", () => {
  it("still reports a bag that is not in the registry", async () => {
    identities.push({ id: 1, name: "bux", metadata: { bags: ["ghost"] } });

    await bagDoctorCommand({});

    expect(text()).toContain("stale reference");
    expect(text()).toContain("ghost");
  });

  it("still reports traits missing from the DB", async () => {
    bags.set("git", fakeBag("git"));
    identities.push({ id: 1, name: "bux", metadata: { bags: ["git"] } });
    // traitRows deliberately empty — git's trait row never made it to the DB.

    await bagDoctorCommand({});

    expect(text()).toContain("traits missing from DB");
  });
});

/**
 * Host binaries.
 *
 * Doctor had no binary check at all, which is why the failure that prompted
 * this went unreported: clickhousectl sat in ~/.local/bin, the MCP server's
 * launchd PATH did not list it, every tool call said "not installed", and
 * `barry bag doctor` said nothing.
 *
 * The state that matters is "installed but unreachable". A check resolving
 * against the CLI's own PATH reports it as healthy — the CLI can see
 * ~/.local/bin — so these pin that doctor asks about the server's PATH and
 * reports the two failure modes differently.
 */
describe("bag doctor — host binaries", () => {
  function bagWithDep(name: string, dep: FakeDependency): void {
    const bag = fakeBag(name);
    bag.dependencies = [dep];
    bags.set(name, bag);
    traitRows.push({ name, namespaces: [name] });
    identities.push({ id: 1, name: "bux", metadata: { bags: [name] } });
  }

  it("reports an installed-but-unreachable binary, and does not call it missing", async () => {
    bagWithDep("clickhouse", {
      name: "clickhousectl",
      install: "curl https://clickhouse.com/cli | sh",
    });
    dependencyStates.set("clickhousectl", {
      state: "unreachable",
      resolvedPath: "/home/dev/.local/bin/clickhousectl",
    });

    await bagDoctorCommand({});

    expect(text()).toContain("clickhousectl");
    expect(text()).toContain("/home/dev/.local/bin/clickhousectl");
    expect(text()).toContain("not on the MCP server's PATH");
    // The remedy has to be the one that works. Reinstalling does not.
    expect(text()).toContain("barry setup");
    expect(text()).not.toContain("executable was not found");
    expect(text()).not.toContain("curl https://clickhouse.com/cli");
  });

  it("reports an optional missing binary without failing the identity health check", async () => {
    mockExistsSync.mockImplementation((path: unknown) => String(path).startsWith("/bags/") || path === "/tmp/snapshot.json");
    mockReadFileSync.mockReturnValue("{}");
    bagWithDep("diagnostics", { name: "sqlite3", optional: true });
    dependencyStates.set("sqlite3", { state: "missing" });
    await bagDoctorCommand({});
    expect(text()).toContain("optional dependency diagnostics:sqlite3: missing");
    expect(text()).toContain("All identities healthy");
    expect(text()).not.toContain("problem found");
  });

  it("reports a genuinely missing binary with its install hint", async () => {
    bagWithDep("clickhouse", {
      name: "clickhousectl",
      install: "curl https://clickhouse.com/cli | sh",
    });
    dependencyStates.set("clickhousectl", { state: "missing" });

    await bagDoctorCommand({});

    expect(text()).toContain("executable was not found");
    expect(text()).toContain("curl https://clickhouse.com/cli | sh");
    expect(text()).not.toContain("not on the MCP server's PATH");
  });

  it("says reachability is unverified when the server's PATH cannot be read", async () => {
    // "I could not tell" must not render as "fine" — that fallback is what
    // produced the original false green.
    bagWithDep("clickhouse", { name: "clickhousectl" });
    dependencyStates.set("clickhousectl", {
      state: "unknown",
      resolvedPath: "/home/dev/.local/bin/clickhousectl",
    });

    await bagDoctorCommand({});

    expect(text()).toContain("could not be read");
    expect(text()).toContain("unverified");
  });

  it("stays quiet about a dependency the server can reach", async () => {
    bagWithDep("clickhouse", { name: "clickhousectl" });
    // No entry in dependencyStates → "ok".

    await bagDoctorCommand({});

    expect(text()).not.toContain("clickhousectl");
  });

  /**
   * A registered bag that no barry packs is still live: its services and jobs
   * run from launchd regardless. The per-barry loop only walks
   * `barry.metadata.bags`, so those bags were never examined — `metrics` (five
   * scheduled jobs, packed by nobody) had a broken dependency that `bag show`
   * reported and `doctor` did not.
   */
  it("checks host binaries for a registered bag no barry packs", async () => {
    const bag = fakeBag("metrics");
    bag.dependencies = [{ name: "/usr/sbin/lsof" }];
    bags.set("metrics", bag);
    dependencyStates.set("/usr/sbin/lsof", { state: "missing" });
    // Deliberately NOT added to any identity's bag list, and another bag is
    // packed so the doctor still has per-barry work to do.
    bags.set("git", fakeBag("git"));
    traitRows.push({ name: "git", namespaces: ["git"] });
    identities.push({ id: 1, name: "bux", metadata: { bags: ["git"] } });

    await bagDoctorCommand({});

    expect(text()).toContain("no barry packs");
    expect(text()).toContain("metrics");
    expect(text()).toContain("/usr/sbin/lsof");
  });

  it("does not re-report a packed bag as unpacked", async () => {
    bagWithDep("clickhouse", { name: "clickhousectl" });
    dependencyStates.set("clickhousectl", { state: "missing" });

    await bagDoctorCommand({});

    // Reported once, through the per-barry path — not again in the sweep.
    expect(text()).toContain("clickhousectl");
    expect(text()).not.toContain("no barry packs");
  });
});

/**
 * Service checks against the service management.
 *
 * Doctor queries the service management for running services. When no service management runs,
 * the check is skipped (not a failure — the user may be running `doctor`
 * before `barry up`).
 */
describe("bag doctor — service management services", () => {
  interface ServiceStatus {
    key: string;
    bag: string;
    name: string;
    state: "starting" | "running" | "backoff" | "stopped" | "conflict";
    autostart: boolean;
    restarts: number;
    health: "ok" | "failing" | "unknown";
    pid?: number;
    port?: number;
    url?: string;
    lastExit?: string;
    loopbackOnly?: boolean;
    conflict?: string;
    problem?: string;
  }

  function managementWith(services: ServiceStatus[]): void {
    mockExistsSync.mockImplementation((path: unknown) => String(path).startsWith("/bags/") || path === serviceRegistryPath());
    mockSupervisorRequest.mockResolvedValue({ instance: {}, services });
  }

  function bagWithService(name: string, svc: { name: string; user?: string }): void {
    const bag = fakeBag(name);
    bag.services = [svc];
    bags.set(name, bag);
  }

  function serviceStatus(
    bag: string,
    name: string,
    overrides: Partial<ServiceStatus> = {},
  ): ServiceStatus {
    return {
      key: `${bag}.${name}`,
      bag,
      name,
      state: "running",
      autostart: true,
      restarts: 0,
      health: "ok",
      loopbackOnly: true,
      ...overrides,
    };
  }

  it("says nothing about a healthy service known to the service management", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([serviceStatus("sessions", "api")]);

    await bagDoctorCommand({});

    expect(text()).not.toContain("sessions.api");
  });

  it("reports a service not known to service management", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([]);

    await bagDoctorCommand({});

    expect(text()).toContain("sessions.api");
    expect(text()).toContain("not known to service management");
  });

  it("skips service checks when no service management is running", async () => {
    bagWithService("sessions", { name: "api" });
    // Default mock throws ServiceManagementError

    await bagDoctorCommand({});

    // Not a failure, just skipped
    expect(text()).toContain("Service management unavailable");
    expect(text()).not.toContain("sessions.api");
  });

  it("reports privileged services missing from the prepared management inventory", async () => {
    bagWithService("vault", { name: "api", user: "_barryvault" });
    managementWith([]);

    await bagDoctorCommand({});

    // user: service should not be reported as missing from service management
    expect(text()).toContain("vault.api");
  });

  it("reports a service in conflict state", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([serviceStatus("sessions", "api", { state: "conflict", conflict: "pid 12345" })]);

    await bagDoctorCommand({});

    expect(text()).toContain("sessions.api");
    expect(text()).toContain("port conflict");
    expect(text()).toContain("pid 12345");
  });

  it("reports a service with a problem", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([serviceStatus("sessions", "api", { problem: "missing binary" })]);

    await bagDoctorCommand({});

    expect(text()).toContain("sessions.api");
    expect(text()).toContain("missing binary");
  });

  it("reports a service bound to a non-loopback address", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([serviceStatus("sessions", "api", { loopbackOnly: false })]);

    await bagDoctorCommand({});

    expect(text()).toContain("sessions.api");
    expect(text()).toContain("non-loopback");
    expect(process.exitCode).toBe(1);
  });

  it("reports a service in backoff", async () => {
    bagWithService("sessions", { name: "api" });
    managementWith([serviceStatus("sessions", "api", { state: "backoff" })]);

    await bagDoctorCommand({});

    expect(text()).toContain("sessions.api");
    expect(text()).toContain("backoff");
  });
});


describe("bag doctor secret contracts", () => {
  it("does not treat ambient shell credentials as an identity binding", async () => {
    bags.set("documents", fakeBag("documents"));
    definitions.set("documents", [{ name: "read_document", namespace: "documents", access: "read", description: "Read", schema: {}, secrets: ["DOCUMENT_API_KEY"], handler: async () => ({ content: [] }) }]);
    identities.push({ id: 1, name: "reader", metadata: { bags: ["documents"] } });
    vi.stubEnv("DOCUMENT_API_KEY", "unrelated-shell-value");
    try {
      await bagDoctorCommand({});
      expect(text()).toContain('needs unbound secrets: DOCUMENT_API_KEY');
      expect(text()).not.toContain("unrelated-shell-value");
    } finally { vi.unstubAllEnvs(); }
  });

  it("uses explicit bindings and ignores disabled tool requirements", async () => {
    bags.set("documents", fakeBag("documents"));
    definitions.set("documents", [{ name: "read_document", namespace: "documents", access: "read", description: "Read", schema: {}, secrets: ["DOCUMENT_API_KEY"], handler: async () => ({ content: [] }) }]);
    identities.push({ id: 1, name: "reader", metadata: { bags: ["documents"], secrets: { DOCUMENT_API_KEY: { reference: { in: "keychain", item: "documents" } } } } });
    await bagDoctorCommand({});
    expect(text()).not.toContain("needs unbound secrets");
    identities[0].metadata = { bags: ["documents"], bag_configs: { documents: { tools: { read_document: "disabled" } } } };
    output = [];
    await bagDoctorCommand({});
    expect(text()).not.toContain("needs unbound secrets");
  });
});


describe("bag doctor extensions", () => {
  it("reports a misregistered extension once and fixes exactly its row", async () => {
    const { parseManifest } = await import("@barry-rocks/sdk/bags");
    const { deleteBag, getBag } = await import("../src/bags/registration.js");
    const { getInvalidManifests } = await import("@barry-rocks/sdk/internal/bags");
    const manifest = (await vi.importActual<typeof import("@barry-rocks/sdk/bags")>("@barry-rocks/sdk/bags")).parseManifestObject({ name: "search", extends: "sessions", description: "Search" });
    bags.set("sessions-search", fakeBag("sessions-search"));
    bags.set("sessions", fakeBag("sessions"));
    vi.mocked(parseManifest).mockImplementation((dir) => dir.endsWith("sessions-search") ? manifest : null);
    vi.mocked(getInvalidManifests).mockReturnValue(new Map([["sessions-search", "stale extension"]]));
    vi.mocked(getBag).mockResolvedValue({ name: "sessions-search", source: { type: "local", path: "/bags/sessions-search" }, builtin: true });
    try {
      await bagDoctorCommand({});
      expect(text()).toContain("Extensions registered under another name");
      expect(text()).toContain("sessions/search");
      expect(text()).not.toContain("Invalid bag manifests");
      expect(deleteBag).not.toHaveBeenCalled();
      output = [];
      await bagDoctorCommand({ fix: true });
      expect(vi.mocked(deleteBag).mock.calls).toEqual([["sessions-search"]]);
      expect(text()).toContain("barry setup");
    } finally {
      vi.mocked(parseManifest).mockReturnValue(null);
      vi.mocked(getInvalidManifests).mockReturnValue(new Map());
    }
  });

  it("reports tools outside the parent's namespace without fixing them", async () => {
    const bag = fakeBag("sessions/search");
    bag.manifest = { name: "search", extends: "sessions" };
    bag.tools = [{ toolName: "search_messages", namespace: "wrong" }];
    bags.set(bag.name, bag);
    const { deleteBag } = await import("../src/bags/registration.js");
    await bagDoctorCommand({ fix: true });
    expect(text()).toContain("search_messages stamps wrong; must stamp parent sessions");
    expect(deleteBag).not.toHaveBeenCalled();
  });
});
