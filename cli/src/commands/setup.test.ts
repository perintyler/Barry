import { openInstance } from "@barry-rocks/sdk/internal/services";
import { barryAppSupportDir, barryLogsDir, barryModelVendorsPath } from "@barry-rocks/sdk/services";
import { ServiceManagement } from "@barry-rocks/mcp-bag";
import { systemOS } from "../services/system.js";
import { nodeRuntime, runtimeTarball } from "../services/runtime.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelVendors, shippedModelVendors } from "@barry-rocks/sdk/adapters/models";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceOS } from "@barry-rocks/mcp-bag";

const deps = vi.hoisted(() => ({ provision: vi.fn(), services: vi.fn(), uninstall: vi.fn(), root: vi.fn() }));
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, owner: { ...actual.owner, installation: () => ({ provision: deps.provision }) } };
});
vi.mock("../services/barry.js", () => ({ installedServices: deps.services }));
vi.mock("./uninstall.js", () => ({ uninstallCommand: deps.uninstall }));
vi.mock("@barry-rocks/sdk/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/sdk/services")>();
  return { ...actual, installationRoot: () => deps.root() ?? actual.installationRoot(), readServiceRegistry: () => ({ resources: {} }) };
});
vi.mock("../apps/app-build.js", () => ({ discoverBagApps: async () => [] }));
vi.mock("@barry-rocks/mcp-bag", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/mcp-bag")>(),
  waitForServices: vi.fn(),
}));
vi.mock("../lib/identity-shims.js", () => ({
  isHomebrewBarry: () => false,
  cliShimDir: () => join(process.env.BARRY_HOME!, "bin"),
  legacyCliShimDirs: () => [],
  removeShim: () => false,
  onPath: () => true,
  pathHint: (dir: string) => `Note: ${dir} is not in your PATH.`,
}));
import { setupCommand } from "./setup.js";

/** launchd that reports no job loaded and refuses any change. */
function serviceOS(): ServiceOS {
  const refuse = () => { throw new Error("setup changed launchd before its ownership check"); };
  return { inspect: () => ({ loaded: false }), load: refuse, unload: async () => refuse(), enable: refuse, start: refuse };
}
const os = serviceOS();
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  deps.provision.mockReset().mockReturnValue({ actorId: 2, name: "Owner", boundAt: 1000 });
  deps.services.mockReset().mockRejectedValue(new Error("test stops before filesystem installation"));
});

describe("setup ownership before service preparation", () => {
  it("provisions before preparing services and forwards explicit selection", async () => {
    await expect(setupCommand({ owner: "2", launchd: os })).rejects.toThrow("test stops");
    expect(deps.provision).toHaveBeenCalledWith({ actorId: 2, username: expect.any(String) });
    expect(deps.provision.mock.invocationCallOrder[0]).toBeLessThan(deps.services.mock.invocationCallOrder[0]);
  });
  it("does not prepare services when ownership selection is ambiguous", async () => {
    deps.provision.mockImplementation(() => { throw new Error("Multiple installation users exist"); });
    await expect(setupCommand({ yes: true, launchd: os })).rejects.toThrow("Multiple installation users");
    expect(deps.services).not.toHaveBeenCalled();
  });
  it("rejects malformed owner IDs before opening the owner store or services", async () => {
    for (const owner of ["0", "01", "-1", "1.5", "9007199254740992", " 2"]) {
      await expect(setupCommand({ owner, launchd: os })).rejects.toThrow("positive user actor ID");
    }
    expect(deps.provision).not.toHaveBeenCalled();
    expect(deps.services).not.toHaveBeenCalled();
  });
  it("does not provision during uninstall previews and rejects an owner/uninstall combination", async () => {
    await setupCommand({ uninstall: true, dryRun: true, launchd: os });
    expect(deps.uninstall).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    await expect(setupCommand({ uninstall: true, owner: "2", launchd: os })).rejects.toThrow("cannot be combined");
    expect(deps.uninstall).toHaveBeenCalledTimes(1);
    expect(deps.provision).not.toHaveBeenCalled();
    expect(deps.services).not.toHaveBeenCalled();
  });
});


describe("setup shipped call code", () => {
  let home: string;
  let root: string;
  function packageAt(kind: string, name: string) {
    const path = join(root, "adapters", kind, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({
      name, version: "1.0.0", type: "module", exports: "./index.js",
      barry: { modelProvider: { contractVersion: 1, factoryExport: "FACTORIES" } },
    }));
    writeFileSync(join(path, "index.js"), `export const FACTORIES = { completion: { ${name}: () => ({}) } };`);
    return path;
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "barry-setup-"));
    root = join(home, "checkout");
    vi.stubEnv("BARRY_HOME", home);
    deps.root.mockReturnValue(root);
    deps.services.mockResolvedValue({ list: async () => [], collectLogs: async () => ({ keys: [], bytes: 0 }) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  it("prints the removed service keys and collected log size", async () => {
    const collectLogs = vi.fn(async () => ({ keys: ["old.api"], bytes: 1234 }));
    deps.services.mockResolvedValue({ list: async () => [], collectLogs });
    await setupCommand({ launchd: os });
    expect(collectLogs).toHaveBeenCalledWith(barryLogsDir());
    expect(console.log).toHaveBeenCalledWith("Collected logs: old.api (1234 bytes)");
  });
  it("records all discovered packages, leaves a second run unchanged and preserves third-party selections", async () => {
    packageAt("completions", "alpha");
    packageAt("embeddings", "beta");
    packageAt("decisions", "gamma");
    const third = packageAt("outside", "third");
    const providers = loadModelVendors({ file: barryModelVendorsPath() });
    await providers.add(third);
    await setupCommand({ launchd: os });
    expect(providers.installed().map(record => record.packageName)).toEqual(["third", "alpha", "beta", "gamma"]);
    const before = readFileSync(barryModelVendorsPath(), "utf8");
    vi.mocked(console.log).mockClear();
    await setupCommand({ launchd: os });
    expect(readFileSync(barryModelVendorsPath(), "utf8")).toBe(before);
    expect(vi.mocked(console.log).mock.calls.flat().some(line => String(line).startsWith("Selected "))).toBe(false);
    expect(providers.installed().find(record => record.packageName === "third")?.shipped).toBeUndefined();
    expect(shippedModelVendors(root)).toHaveLength(3);
  });
  it("updates a moved shipped package and its version", async () => {
    packageAt("completions", "alpha");
    await setupCommand({ launchd: os });
    const moved = join(home, "moved");
    renameSync(root, moved);
    root = moved;
    deps.root.mockReturnValue(root);
    const path = join(root, "adapters", "completions", "alpha");
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    manifest.version = "2.0.0";
    writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
    await setupCommand({ launchd: os });
    expect(loadModelVendors({ file: barryModelVendorsPath() }).installed()).toEqual([
      expect.objectContaining({ packageName: "alpha", path, version: "2.0.0", shipped: true }),
    ]);
  });
  it("repairs changed shipped declarations even when the version stays the same", async () => {
    const path = packageAt("completions", "alpha");
    await setupCommand({ launchd: os });
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    manifest.barry.modelProvider.factoryExport = "CHANGED";
    manifest.exports = "./changed.js";
    writeFileSync(join(path, "changed.js"), "export const CHANGED = { completion: { alpha: () => ({}) } };");
    writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
    await setupCommand({ launchd: os });
    expect(loadModelVendors({ file: barryModelVendorsPath() }).installed()).toEqual([
      expect.objectContaining({ packageName: "alpha", version: "1.0.0", factoryExport: "CHANGED", shipped: true }),
    ]);
  });
  it("adopts a hand-added record that is exactly the shipped one, then keeps it current", async () => {
    const path = packageAt("completions", "alpha");
    await loadModelVendors({ file: barryModelVendorsPath() }).add(path);
    await setupCommand({ launchd: os });
    expect(loadModelVendors({ file: barryModelVendorsPath() }).installed()).toEqual([
      expect.objectContaining({ packageName: "alpha", path, shipped: true }),
    ]);
    expect(vi.mocked(console.log).mock.calls.flat()).toContain(`Adopted alpha from ${path}.`);
    const before = readFileSync(barryModelVendorsPath(), "utf8");
    vi.mocked(console.log).mockClear();
    await setupCommand({ launchd: os });
    expect(readFileSync(barryModelVendorsPath(), "utf8")).toBe(before);
    expect(vi.mocked(console.log).mock.calls.flat().some(line => /^(Adopted|Selected) /.test(String(line)))).toBe(false);
    const moved = join(home, "moved");
    renameSync(root, moved);
    deps.root.mockReturnValue(moved);
    await setupCommand({ launchd: os });
    expect(loadModelVendors({ file: barryModelVendorsPath() }).installed()).toEqual([
      expect.objectContaining({ packageName: "alpha", path: join(moved, "adapters", "completions", "alpha"), shipped: true }),
    ]);
  });
  it("preserves a user selection of a shipped package name from another directory", async () => {
    packageAt("completions", "alpha");
    const replacement = packageAt("outside", "alpha");
    await loadModelVendors({ file: barryModelVendorsPath() }).add(replacement);
    const before = readFileSync(barryModelVendorsPath(), "utf8");
    await setupCommand({ launchd: os });
    expect(readFileSync(barryModelVendorsPath(), "utf8")).toBe(before);
    expect(vi.mocked(console.log).mock.calls.flat().some(line => /^(Adopted|Selected) /.test(String(line)))).toBe(false);
  });
  it("reports an unbuilt package without recording it and still records healthy packages", async () => {
    const path = packageAt("completions", "alpha");
    packageAt("decisions", "beta");
    rmSync(join(path, "index.js"));
    await setupCommand({ launchd: os });
    expect(loadModelVendors({ file: barryModelVendorsPath() }).installed().map(record => record.packageName)).toEqual(["beta"]);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("pnpm build:packages");
    expect(existsSync(barryModelVendorsPath())).toBe(true);
  });
});

it("refuses root ordinary setup before provisioning ownership", async () => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  await expect(setupCommand({ launchd: os })).rejects.toThrow(/login user.*launchd.*--system.*container.*root/); expect(deps.provision).not.toHaveBeenCalled(); expect(deps.services).not.toHaveBeenCalled();
});
it("previews on --dry-run alone and refuses incompatible system options", async () => {
  // --dry-run on the normal pass is a read-only preview now: it changes
  // nothing and never provisions.
  await setupCommand({ dryRun: true, launchd: os });
  for (const extra of [{ start: false }, { owner: "2" }, { apps: ["barry.App"] }]) await expect(setupCommand({ system: true, launchd: os, ...extra })).rejects.toThrow("cannot be combined");
  expect(deps.provision).not.toHaveBeenCalled(); expect(deps.services).not.toHaveBeenCalled();
});
it("refuses nonroot system setup before observing the instance", async () => {
  vi.spyOn(process, "getuid").mockReturnValue(501);
  await expect(setupCommand({ system: true, launchd: os })).rejects.toThrow("needs root"); expect(deps.provision).not.toHaveBeenCalled(); expect(deps.services).not.toHaveBeenCalled();
});

it("prepares a system service as the owner and prints the needs line without applying it", async () => {
  const home = barryAppSupportDir(); const instance = openInstance(home);
  deps.root.mockReturnValue(join(home, "empty-checkout"));
  const manager = new ServiceManagement(instance, [{ name: "vault.api", user: "_barryvault", domain: "system", command: ["/usr/bin/true"], directory: join(home, "code"), plistDirectory: join(home, "plists"), logDirectory: join(home, "logs") }], os);
  mkdirSync(home, { recursive: true }); writeFileSync(join(home, "service-definitions.json"), JSON.stringify({ "vault.api": { key: "vault.api", bag: "vault", name: "api", entry: join(home, "source", "server.mjs") } }));
  deps.services.mockResolvedValue(manager); const apply = vi.spyOn(manager, "apply"); const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {}); const download = vi.fn(async () => new TextEncoder().encode("not the pinned tarball"));
  await setupCommand({ launchd: os, systemOS: { ...systemOS(), exists: () => false, digest: () => null }, download });
  expect(output).toHaveBeenCalledWith(expect.stringContaining("vault.api: needs `sudo barry setup --system`")); expect(apply).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledWith(expect.stringContaining(`its runtime node v${nodeRuntime().version} is not installed`));
  // The runtime is missing, so setup fetched it; a download that fails its digest is reported, never cached.
  expect(download).toHaveBeenCalledWith(nodeRuntime().url); expect(existsSync(runtimeTarball())).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("does not match its pinned SHA-256"));
  download.mockClear();
  await setupCommand({ launchd: os, systemOS: { ...systemOS(), exists: () => true, digest: () => null }, download });
  expect(download).not.toHaveBeenCalled();
});
