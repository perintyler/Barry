import { afterEach, describe, expect, it, vi } from "vitest";
import { symlinkSync, readlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsAgent, uninstallCommand } from "../src/commands/uninstall.js";
import { systemPaths } from "../src/services/system.js";
import { inertServiceOS, type JobState, type ServiceOS } from "@barry-rocks/mcp-bag";

const testHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of testHomes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore test cleanup failure */
    }
  }
});

/** A throwaway instance under BARRY_HOME whose instance.json carries `id`. */
function instanceRoot(prefix: string, id: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  testHomes.push(root);
  vi.stubEnv("BARRY_HOME", root);
  mkdirSync(join(root, "app-support"), { recursive: true });
  writeFileSync(join(root, "app-support", "instance.json"), JSON.stringify({ id }));
  return root;
}

function plist(dir: string, label: string): string {
  const path = join(dir, `${label}.plist`);
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>Label</key><string>${label}</string></dict></plist>`);
  return path;
}

function createMockOS() {
  const states = new Map<string, JobState>();
  const calls: string[] = [];

  const os: ServiceOS = {
    inspect: (_domain, label) => states.get(label) ?? { loaded: false },
    load: (_domain, path) => {
      calls.push(`load:${path}`);
    },
    unload: async (_domain, label) => {
      calls.push(`unload:${label}`);
      states.set(label, { loaded: false });
    },
    enable: (_domain, label, enabled) => {
      calls.push(`enable:${label}:${enabled}`);
    },
    start: (_domain, label) => {
      calls.push(`start:${label}`);
      states.set(label, { loaded: true, pid: 999 });
    },
  };

  return { os, states, calls };
}

describe("uninstallCommand", () => {
  it("performs dry-run without removing files or changing launchd", async () => {
    const root = instanceRoot("barry-uninstall-test-", "inst1");

    const agentsDir = join(root, "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    const plist1 = join(agentsDir, "rocks.barry.inst1.test.api.plist");
    writeFileSync(
      plist1,
      `<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>Label</key><string>rocks.barry.inst1.test.api</string></dict></plist>`,
    );

    const shimDir = join(root, "bin");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "barry");
    writeFileSync(shim, "#!/bin/sh\necho barry\n");

    const mock = createMockOS();
    mock.states.set("rocks.barry.inst1.test.api", { loaded: true, pid: 1234 });

    const summary = await uninstallCommand({
      dryRun: true,
      systemDaemonsDir: join(root, "no-daemons"),
      launchAgentsDir: agentsDir,
      shimDirs: [shimDir],
      launchd: mock.os,
      log: () => {},
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.servicesUnloaded).toContain("rocks.barry.inst1.test.api");
    expect(summary.plistsRemoved).toContain(plist1);
    expect(summary.shimsRemoved).toContain(shim);

    // Files MUST still exist
    expect(existsSync(plist1)).toBe(true);
    expect(existsSync(shim)).toBe(true);
    // OS unload MUST NOT have been called
    expect(mock.calls).toHaveLength(0);
  });

  it("sweeps ~/.local/bin by default (the new shim home) when no shimDirs are given", async () => {
    // No BARRY_HOME: the default candidate dirs come from the shared resolver,
    // which now defaults to ~/.local/bin. A plain barry there must be removed.
    const home = mkdtempSync(join(tmpdir(), "barry-uninstall-default-shim-"));
    testHomes.push(home);
    delete process.env.BARRY_HOME;
    vi.stubEnv("HOME", home);
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const shim = join(localBin, "barry");
    writeFileSync(shim, "#!/bin/sh\necho barry\n");
    const mock = createMockOS();
    const summary = await uninstallCommand({
      dryRun: false,
      launchAgentsDir: join(home, "no-agents"),
      systemDaemonsDir: join(home, "no-daemons"),
      launchd: mock.os,
      log: () => {},
    });
    expect(summary.shimsRemoved).toContain(shim);
    expect(existsSync(shim)).toBe(false);
  });

  it("removes an instance's own agents and command, and leaves every other instance's alone", async () => {
    // A dev instance's uninstall used to unload every rocks.barry.* agent and
    // delete /opt/homebrew/bin/barry: the installed instance went with it.
    const root = instanceRoot("barry-uninstall-test-", "inst1");
    const agentsDir = join(root, "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    const own = plist(agentsDir, "rocks.barry.inst1.service1");
    const other = plist(agentsDir, "rocks.barry.other-inst.service1");
    const legacy = plist(agentsDir, "com.barry.legacy.service2");
    const foreign = plist(agentsDir, "com.other.app");

    mkdirSync(join(root, "bin"));
    const shim = join(root, "bin", "barry");
    writeFileSync(shim, "#!/bin/sh\necho barry\n");

    const mock = createMockOS();
    for (const label of ["rocks.barry.inst1.service1", "rocks.barry.other-inst.service1", "com.barry.legacy.service2"]) {
      mock.states.set(label, { loaded: true, pid: 101 });
    }

    // No shimDirs: the instance's own bin is the only place it looks.
    const summary = await uninstallCommand({ dryRun: false, purge: false, systemDaemonsDir: join(root, "no-daemons"), launchAgentsDir: agentsDir, launchd: mock.os, log: () => {} });

    expect(summary.servicesUnloaded).toEqual(["rocks.barry.inst1.service1"]);
    expect(summary.plistsRemoved).toEqual([own]);
    expect(summary.shimsRemoved).toEqual([shim]);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(shim)).toBe(false);
    for (const kept of [other, legacy, foreign]) expect(existsSync(kept)).toBe(true);
    expect(mock.calls).toEqual(["unload:rocks.barry.inst1.service1", "enable:rocks.barry.inst1.service1:false"]);
  });

  it("an instance whose record is unreadable owns no agents", () => {
    const root = mkdtempSync(join(tmpdir(), "barry-uninstall-test-"));
    testHomes.push(root);
    expect(ownsAgent(root, join(root, "app-support"))("rocks.barry.anything.service")).toBe(false);
  });

  it("the machine's own instance sweeps every Barry agent, including pre-instance ones", () => {
    const owns = ownsAgent(null, "/unused");
    expect(owns("rocks.barry.old-inst.service1")).toBe(true);
    expect(owns("com.barry.legacy.service2")).toBe(true);
    expect(owns("com.other.app")).toBe(false);
  });

  it("permanently removes durable directories when --purge and --yes are specified", async () => {
    const root = mkdtempSync(join(tmpdir(), "barry-purge-test-"));
    testHomes.push(root);

    // Use BARRY_HOME to isolate durable directories
    vi.stubEnv("BARRY_HOME", root);

    try {
      const appSupport = join(root, "app-support");
      const logs = join(root, "logs");
      const config = join(root, "config");

      mkdirSync(appSupport, { recursive: true });
      mkdirSync(logs, { recursive: true });
      mkdirSync(config, { recursive: true });

      writeFileSync(join(appSupport, "sessions.db"), "data");
      writeFileSync(join(logs, "app.log"), "log content");
      writeFileSync(join(config, "hosting.yaml"), "local: true");

      const mock = createMockOS();
      const summary = await uninstallCommand({
        dryRun: false,
        purge: true,
        yes: true,
        systemDaemonsDir: join(root, "no-daemons"),
        launchAgentsDir: join(root, "no-agents"),
        shimDirs: [],
        launchd: mock.os,
        log: () => {},
      });

      expect(summary.purged).toBe(true);
      expect(summary.dataPurged).toContain(appSupport);
      expect(summary.dataPurged).toContain(logs);
      expect(summary.dataPurged).toContain(config);

      expect(existsSync(appSupport)).toBe(false);
      expect(existsSync(logs)).toBe(false);
      expect(existsSync(config)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("scopes the system sweep to this instance and keeps system data without --purge", async () => {
  const root = instanceRoot("barry-uninstall-system-", "inst1"); const daemons = join(root, "daemons"); mkdirSync(daemons);
  const own = plist(daemons, "rocks.barry.inst1.vault.api"); const other = plist(daemons, "rocks.barry.other.vault.api"); plist(daemons, "com.barry.bag.vault.api");
  const state = join(root, "state"); const code = join(root, "code"); mkdirSync(state); mkdirSync(code);
  writeFileSync(join(root, "app-support", "managed-definitions.json"), JSON.stringify([{ name: "vault.api", domain: "system", user: "_barryvault", command: ["/usr/bin/true"], directory: code, plistDirectory: daemons, logDirectory: join(state, "logs"), environment: { BARRY_BAG_DATA_DIR: state } }]));
  const paths: typeof systemPaths = (instance, bag, key) => ({ ...systemPaths(instance, bag, key), state });
  const mock = createMockOS(); const summary = await uninstallCommand({ system: true, dryRun: true, launchd: mock.os, launchAgentsDir: join(root, "no-agents"), systemDaemonsDir: daemons, systemCodeDir: code, systemPaths: paths, shimDirs: [], log: () => {} });
  expect(summary.systemDaemonsDetected).toEqual(["rocks.barry.inst1.vault.api"]); expect(summary.systemDaemonsRemoved).toEqual([own, code]); expect(summary.dataRetained).toContain(state); expect(summary.dataPurged).not.toContain(state);
  expect(mock.calls).toEqual([]); expect(existsSync(other)).toBe(true); expect(existsSync(own)).toBe(true);
  const purge = await uninstallCommand({ system: true, dryRun: true, purge: true, launchd: mock.os, launchAgentsDir: join(root, "no-agents"), systemDaemonsDir: daemons, systemCodeDir: code, systemPaths: paths, shimDirs: [], log: () => {} }); expect(purge.dataPurged).toContain(state);
});
it("purges only this instance's system state, whatever its definitions name", async () => {
  const root = instanceRoot("barry-uninstall-copied-", "inst1"); const elsewhere = join(root, "another-instance-state"); mkdirSync(elsewhere);
  // A definition copied from another instance still names that instance's state directory.
  writeFileSync(join(root, "app-support", "managed-definitions.json"), JSON.stringify([{ name: "vault.api", domain: "system", user: "_barryvault", command: ["/usr/bin/true"], directory: root, plistDirectory: root, logDirectory: join(elsewhere, "logs"), environment: { BARRY_BAG_DATA_DIR: elsewhere } }]));
  const summary = await uninstallCommand({ system: true, dryRun: true, purge: true, launchd: createMockOS().os, launchAgentsDir: join(root, "no-agents"), systemDaemonsDir: join(root, "no-daemons"), systemCodeDir: join(root, "code"), shimDirs: [], log: () => {} });
  expect(summary.dataPurged).not.toContain(elsewhere); expect(summary.dataRetained).not.toContain(elsewhere);
});
it("refuses a bag name that is not one path segment", () => {
  const instance = { id: "inst1", home: "/home" };
  for (const bag of ["../vault", "vault/../..", "..", ""]) expect(() => systemPaths(instance, bag, "vault.api")).toThrow("not a bag name");
  expect(systemPaths(instance, "vault", "vault.api").code).toBe("/usr/local/libexec/barry/inst1/vault.api");
});

describe("uninstall installation code", () => {
  function installed() {
    const root = instanceRoot("barry-uninstall-current-", "installed");
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("BARRY_NODE", process.execPath);
    const target = join(root, "checkout");
    mkdirSync(target);
    mkdirSync(join(root, "app-support/releases"));
    symlinkSync(target, join(root, "app-support/current"));
    const agents = join(root, "agents");
    const daemons = join(root, "daemons");
    const shims = join(root, "bin");
    for (const dir of [agents, daemons, shims]) mkdirSync(dir);
    return { root, target, current: join(root, "app-support/current"), releases: join(root, "app-support/releases"), options: { launchd: createMockOS().os, launchAgentsDir: agents, systemDaemonsDir: daemons, shimDirs: [shims], log: vi.fn() } };
  }
  it("lists installation paths in a dry run and removes neither", async () => {
    const f = installed();
    const result = await uninstallCommand({ ...f.options, dryRun: true });
    expect(result.installationRemoved).toEqual([f.current, f.releases]);
    expect(readlinkSync(f.current)).toBe(f.target);
    expect(existsSync(f.releases)).toBe(true);
  });
  it("removes the selector and release copies while leaving the checkout", async () => {
    const f = installed();
    const result = await uninstallCommand(f.options);
    expect(result.installationRemoved).toEqual([f.current, f.releases]);
    expect(existsSync(f.current)).toBe(false);
    expect(existsSync(f.releases)).toBe(false);
    expect(existsSync(f.target)).toBe(true);
  });
  it.each(["release", "link"])("retains %s code and a runnable privileged command for an owned system plist", async kind => {
    const f = installed();
    if (kind === "release") writeFileSync(join(f.target, "release.json"), JSON.stringify({ version: "0.0.0-test", commit: "1".repeat(40), platform: "darwin-arm64", node: { version: "26.5.0", sha256: "2".repeat(64) }, stores: {}, built: "2026-10-08T00:00:00.000Z" }));
    plist(f.options.systemDaemonsDir, "rocks.barry.installed.vault.api");
    const result = await uninstallCommand({ ...f.options, purge: true, yes: true });
    expect(result.installationRemoved).toEqual([]);
    expect(existsSync(f.current)).toBe(true);
    expect(existsSync(f.releases)).toBe(true);
    expect(f.options.log.mock.calls.flat().join("\n")).toContain(join(f.current, kind === "release" ? "bin/barry" : "cli/bin/barry.js"));
    if (kind === "link") expect(f.options.log.mock.calls.flat().join("\n")).toContain(process.execPath);
  });
  it("leaves Homebrew's link and prints its uninstall hint", async () => {
    const f = installed();
    const keg = join(f.root, "Cellar/barry/0.1.0/libexec/bin/barry");
    mkdirSync(join(keg, ".."), { recursive: true });
    writeFileSync(keg, "barry");
    const shim = join(f.options.shimDirs[0], "barry");
    symlinkSync(keg, shim);
    const result = await uninstallCommand(f.options);
    expect(result.shimsRemoved).not.toContain(shim);
    expect(readlinkSync(shim)).toBe(keg);
    expect(f.options.log.mock.calls.flat()).toContain("Homebrew installed barry: run `brew uninstall barry`.");
  });
});

it("refuses system removal on an unsupported host before touching owned artifacts, even as root", async () => {
  const root = instanceRoot("barry-uninstall-unsupported-", "inst1");
  const daemons = join(root, "daemons"), code = join(root, "code");
  mkdirSync(daemons); mkdirSync(code);
  const registration = plist(daemons, "rocks.barry.inst1.vault.api");
  writeFileSync(join(code, "marker"), "kept");
  vi.spyOn(process, "getuid").mockReturnValue(0);
  await expect(uninstallCommand({ system: true, purge: true, yes: true, launchd: inertServiceOS(), systemDaemonsDir: daemons, systemCodeDir: code, log: () => {} })).rejects.toThrow("system uninstall needs sudo");
  expect(existsSync(registration)).toBe(true);
  expect(readFileSync(join(code, "marker"), "utf8")).toBe("kept");
  expect(existsSync(join(root, "app-support/instance.json"))).toBe(true);
});
