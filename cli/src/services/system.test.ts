import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openInstance, stableNodePath } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, renderService } from "@barry-rocks/mcp-bag";
import type { JobState, ServiceOS } from "@barry-rocks/mcp-bag";

import { nodeRuntime, sha256 } from "./runtime.js";
import { applySystem, assertAccountName, assertRootProtected, codeDigest, legacyLabel, observeSystem, planSystem, reportSystem, selectAccountId, setupSystem, systemDefinition, systemOS, systemPaths, type SystemOS, type SystemPaths } from "./system.js";
import type { ServiceSpec } from "./specs.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-system-")); roots.push(root);
  vi.stubEnv("BARRY_HOME", root);
  const instance = openInstance(join(root, "home"));
  const paths: SystemPaths = { code: join(root, "code", "vault.api"), runtime: join(root, "code", "runtime", nodeRuntime().name), tarball: join(root, "cache", `${nodeRuntime().name}.tar.gz`), state: join(root, "state"), logs: join(root, "state", "logs"), legacy: join(root, "legacy"), plists: join(root, "plists") };
  mkdirSync(paths.plists); mkdirSync(join(root, "source"));
  const spec: ServiceSpec = { key: "vault.api", bag: "vault", name: "api", description: "vault", entry: join(root, "source", "server.mjs"), command: stableNodePath(), args: [], cwd: root, env: [], secrets: ["PASSWORD"], autostart: "login", localOnly: false, injects: [], user: "_barryvault", socket: join(paths.state, "run", "vault.sock"), health: "/health" };
  writeFileSync(spec.entry!, "first code", { mode: 0o644 });
  const definition = systemDefinition(spec, paths);
  const states = new Map<string, JobState>(); const changes: string[] = [];
  const label = `rocks.barry.${instance.id}.vault.api`;
  const serviceOS: ServiceOS = {
    inspect: (_domain, label) => states.get(label) ?? { loaded: false },
    load: (_domain, path) => { const label = basename(path, ".plist"); changes.push(`load:${label}`); states.set(label, { loaded: true, pid: 123 }); },
    unload: async (_domain, label) => { changes.push(`unload:${label}`); states.delete(label); },
    enable: (_domain, _label, enabled) => { changes.push(`enable:${enabled}`); },
    start: (_domain, label) => { changes.push(`start:${label}`); states.set(label, { loaded: true, pid: 123 }); },
  };
  const manager = new ServiceManagement(instance, [definition], serviceOS);
  const legacy = join(paths.plists, `${legacyLabel(spec.key)}.plist`);
  const os: SystemOS = {
    uid: () => 0, sudoUid: () => instance.uid, owner: () => "owner",
    account: () => ({ uid: 401, gid: 401, group: "_barryvault" }), ids: () => ({ uids: [400], gids: [] }), member: () => true,
    exists: existsSync, read: (path) => readFileSync(path, "utf8"), digest: codeDigest, fileDigest: () => nodeRuntime().sha256, protected: () => true, stateParent: dirname, environmentNames: () => ["OLD_SECRET"],
    createAccount: (name, id) => { changes.push(`account:${name}:${id}`); }, addMember: (owner, group) => { changes.push(`group:${owner}:${group}`); },
    directory: (path) => { changes.push(`directory:${path}`); mkdirSync(path, { recursive: true }); },
    stage: (source, code) => { changes.push("stage"); cpSync(source, `${code}.staging`, { recursive: true, dereference: true }); },
    stageRuntime: (_tarball, _digest, runtime) => { changes.push("stage-runtime"); mkdirSync(join(`${runtime}.staging`, "bin"), { recursive: true }); writeFileSync(join(`${runtime}.staging`, "bin", "node"), "node"); },
    loadNativeModules: (node, code) => { changes.push(`load:${basename(dirname(dirname(node)))}:${basename(code)}`); },
    swap: (code) => { changes.push(code === paths.runtime ? "swap-runtime" : "swap"); if (existsSync(code)) renameSync(code, `${code}.previous`); renameSync(`${code}.staging`, code); },
    restore: (code) => { changes.push(code === paths.runtime ? "restore-runtime" : "restore"); rmSync(code, { recursive: true, force: true }); if (existsSync(`${code}.previous`)) renameSync(`${code}.previous`, code); },
    saveLegacy: (source, target) => { changes.push("save"); cpSync(source, target); },
    writePlist: (path, contents) => { changes.push("restore-plist"); writeFileSync(path, contents); },
    remove: (path) => { changes.push("remove-legacy"); rmSync(path); },
  };
  const writeRecords = () => { writeFileSync(join(instance.home, "managed-definitions.json"), JSON.stringify([definition])); writeFileSync(join(instance.home, "service-definitions.json"), JSON.stringify({ [spec.key]: spec })); };
  writeRecords();
  const observe = () => observeSystem(manager, spec, os, serviceOS, paths);
  const live = () => { for (const path of [paths.code, paths.state, paths.logs, paths.legacy]) mkdirSync(path, { recursive: true }); writeFileSync(legacy, "legacy bytes with secrets"); states.set(legacyLabel(spec.key), { loaded: true, pid: 101 }); };
  const installRuntime = () => { mkdirSync(join(paths.runtime, "bin"), { recursive: true }); writeFileSync(join(paths.runtime, "bin", "node"), "node"); };
  const current = async () => { live(); installRuntime(); rmSync(legacy); states.delete(legacyLabel(spec.key)); cpSync(dirname(spec.entry!), paths.code, { recursive: true }); await manager.apply(spec.key, "add"); await manager.apply(spec.key, "enable"); states.set(label, { loaded: true, pid: 123 }); changes.length = 0; };
  const wait = vi.fn(async () => { changes.push("health"); });
  return { root, instance, paths, spec, definition, manager, serviceOS, os, states, label, legacy, changes, observe, live, current, installRuntime, writeRecords, wait };
}

describe("system preparation and planning", () => {
  it("selects the first pair free as both uid and gid and rejects exhausted IDs and invalid names", () => {
    expect(selectAccountId({ uids: [400, 402], gids: [401] })).toBe(403);
    expect(() => selectAccountId({ uids: Array.from({ length: 41 }, (_, i) => i + 400), gids: [] })).toThrow("no free");
    expect(() => assertAccountName("barryvault")).toThrow("invalid"); expect(() => assertAccountName("_barryvault")).not.toThrow();
  });
  it("keeps per-instance code/state paths while preserving the machine's data path", () => {
    const f = fixture();
    expect(systemPaths(f.instance, "vault", "vault.api").state).toBe(`/usr/local/var/barry-vault-${f.instance.id}`);
    vi.stubEnv("BARRY_HOME", ""); expect(systemPaths(f.instance, "vault", "vault.api").state).toBe("/usr/local/var/barry-vault");
  });
  it("emits only the isolated system environment and built entry", () => {
    const f = fixture();
    expect(f.definition).toMatchObject({ domain: "system", user: "_barryvault", directory: f.paths.code, logDirectory: f.paths.logs, command: [join(f.paths.runtime, "bin", "node"), join(f.paths.code, "server.mjs")] });
    expect(f.definition.environment).toEqual({ PATH: "/usr/bin:/bin", BARRY_SERVICE: "vault.api", BARRY_BAG_DATA_DIR: f.paths.state, BARRY_SERVICE_SOCKET: f.spec.socket });
    const plist = renderService(f.definition, f.label, true); expect(plist).not.toMatch(/PASSWORD|HOME|BARRY_DIR|barry-service/); expect(plist).toContain("_barryvault");
  });
  it("plans every action on a fresh machine", () => {
    const f = fixture(); f.os.account = () => undefined;
    expect(planSystem(f.observe()).map((a) => a.kind)).toEqual(["account", "group", "directory", "directory", "directory", "directory", "stage", "stage-runtime", "load", "swap", "swap-runtime", "add", "enable", "start", "health"]);
  });
  it("plans the legacy cutover without touching the existing account, group or state", () => {
    const f = fixture(); f.live();
    const plan = planSystem(f.observe());
    expect(plan.map((a) => a.kind)).toEqual(["directory", "stage", "stage-runtime", "load", "save", "stop-legacy", "swap", "swap-runtime", "add", "enable", "start", "health", "remove-legacy"]);
    expect(plan[0].path).toBe(dirname(f.paths.runtime)); expect(plan[0].uid).toBe(0);
    const report = reportSystem(f.observe(), planSystem(f.observe()), true).join("\n"); expect(report).toContain("OLD_SECRET"); expect(report).toContain("rotate them"); expect(report).not.toContain("legacy bytes with secrets");
  });
  it("plans nothing for installed, current, running code and stages/switches a running update", async () => {
    const f = fixture(); await f.current(); expect(planSystem(f.observe())).toEqual([]);
    writeFileSync(f.spec.entry!, "second code"); expect(planSystem(f.observe()).map((a) => a.kind)).toEqual(["stage", "load", "swap", "restart", "health"]);
  });
});
describe("system switch and rollback", () => {
  it("saves the legacy plist and removes it only after a healthy registered enabled replacement", async () => {
    const f = fixture(); f.live(); const o = f.observe();
    await applySystem(f.manager, o, planSystem(o), f.os, f.serviceOS, f.wait);
    expect(readFileSync(join(f.paths.legacy, basename(f.legacy)), "utf8")).toBe("legacy bytes with secrets"); expect(existsSync(f.legacy)).toBe(false);
    expect(f.manager.choice(f.spec.key)).toEqual({ registered: true, enabled: true }); expect(f.states.get(f.label)?.pid).toBe(123);
    expect(f.changes.indexOf("health")).toBeLessThan(f.changes.indexOf("remove-legacy"));
  });
  it("removes the unhealthy replacement and reloads the still-present legacy plist", async () => {
    const f = fixture(); f.live(); const o = f.observe();
    await expect(applySystem(f.manager, o, planSystem(o), f.os, f.serviceOS, async () => { throw new Error("health failed"); })).rejects.toThrow(/health failed.*restored com.barry.bag.vault.api/);
    expect(existsSync(f.legacy)).toBe(true); expect(f.states.get(legacyLabel(f.spec.key))?.loaded).toBe(true); expect(f.states.has(f.label)).toBe(false);
    expect(f.changes).toContain("restore-runtime"); expect(existsSync(f.paths.runtime)).toBe(false);
  });
  it("restores previous code and running policy after an update failure", async () => {
    const f = fixture(); await f.current(); writeFileSync(f.spec.entry!, "second code"); const o = f.observe();
    await expect(applySystem(f.manager, o, planSystem(o), f.os, f.serviceOS, async () => { throw new Error("health failed"); })).rejects.toThrow(`restored ${f.label}`);
    expect(readFileSync(join(f.paths.code, "server.mjs"), "utf8")).toBe("first code"); expect(f.states.get(f.label)?.pid).toBe(123); expect(f.manager.choice(f.spec.key).enabled).toBe(true);
  });
  it("dry run calls no mutation method and reports the unreadable legacy environment and the runtime it would install", async () => {
    const f = fixture(); f.live(); f.os.environmentNames = () => undefined; const lines: string[] = [];
    await setupSystem(f.instance.home, f.serviceOS, f.os, { dryRun: true, paths: () => f.paths, log: (line) => lines.push(line) });
    expect(f.changes).toEqual([]); expect(existsSync(join(f.instance.home, "services.json"))).toBe(false); expect(lines.join("\n")).toContain("cannot be read without sudo");
    expect(lines).toContain(`  would install runtime node v${nodeRuntime().version} (sha256 verified) into ${f.paths.runtime}.staging (read-only, root:wheel)`);
  });
});
describe("system setup refusals before mutation", () => {
  it("requires root and SUDO_UID, an existing owned instance and prepared records", async () => {
    const f = fixture(); const run = (dryRun = false) => setupSystem(f.instance.home, f.serviceOS, f.os, { dryRun, paths: () => f.paths, log: () => {} });
    f.os.uid = () => 501; f.os.exists = vi.fn(() => { throw new Error("read before root check"); }); await expect(run()).rejects.toThrow("needs root"); expect(f.os.exists).not.toHaveBeenCalled();
    f.os.exists = existsSync; f.os.uid = () => 0; f.os.sudoUid = () => undefined; await expect(run()).rejects.toThrow("SUDO_UID");
    f.os.sudoUid = () => f.instance.uid! + 1; await expect(run()).rejects.toThrow("differs"); f.os.sudoUid = () => f.instance.uid;
    rmSync(join(f.instance.home, "managed-definitions.json")); await expect(run()).rejects.toThrow("missing definitions");
    rmSync(join(f.instance.home, "instance.json")); await expect(run()).rejects.toThrow("missing instance.json"); expect(existsSync(join(f.instance.home, "instance.json"))).toBe(false); expect(f.changes).toEqual([]);
  });
  it("permits nonroot dry runs for the owning instance", async () => {
    const f = fixture(); f.os.uid = () => f.instance.uid!;
    await setupSystem(f.instance.home, f.serviceOS, f.os, { dryRun: true, paths: () => f.paths, log: () => {} }); expect(f.changes).toEqual([]);
  });
  it("rejects old definitions, missing builds, login accounts and unprotected parents", () => {
    const f = fixture(); f.definition.environment!.HOME = f.root; expect(f.observe).toThrow("run `barry setup` first"); delete f.definition.environment!.HOME;
    rmSync(f.spec.entry!); expect(f.observe).toThrow("build it first"); writeFileSync(f.spec.entry!, "code");
    f.os.account = () => ({ uid: 501, gid: 501, group: "owner" }); expect(f.observe).toThrow("login account");
    f.os.account = () => ({ uid: 401, gid: 401, group: "_barryvault" }); f.os.protected = () => false; expect(f.observe).toThrow("not root-protected"); expect(f.changes).toEqual([]);
  });
});
describe("real filesystem boundary in scratch directories", () => {
  it("stages dereferenced read-only code, swaps once and restores previous code", () => {
    const f = fixture(); const os = systemOS(); mkdirSync(dirname(f.paths.code)); mkdirSync(f.paths.code); writeFileSync(join(f.paths.code, "server.mjs"), "old");
    const dependency = join(f.root, "dependency"); mkdirSync(dependency); writeFileSync(join(dependency, "native.node"), "native"); symlinkSync(dependency, join(dirname(f.spec.entry!), "native"));
    chmodSync(dirname(f.spec.entry!), 0o700); chmodSync(f.spec.entry!, 0o600);
    os.stage(dirname(f.spec.entry!), f.paths.code); expect(statSync(join(`${f.paths.code}.staging`, "server.mjs")).mode & 0o777).toBe(0o444);
    expect(statSync(join(`${f.paths.code}.staging`, "server.mjs")).uid).toBe(process.getuid?.()); expect(readdirSync(join(`${f.paths.code}.staging`, "native"))).toEqual(["native.node"]);
    expect(codeDigest(dirname(f.spec.entry!))).toBe(codeDigest(`${f.paths.code}.staging`)); os.swap(f.paths.code); expect(readFileSync(join(`${f.paths.code}.previous`, "server.mjs"), "utf8")).toBe("old"); os.restore(f.paths.code); expect(readFileSync(join(f.paths.code, "server.mjs"), "utf8")).toBe("old");
  });
  it("strips set-id bits from staged code, which becomes root-owned", () => {
    const f = fixture(); const os = systemOS(); mkdirSync(dirname(f.paths.code));
    const tool = join(dirname(f.spec.entry!), "tool"); writeFileSync(tool, "#!/bin/sh\n"); chmodSync(tool, 0o6755);
    expect(statSync(tool).mode & 0o7777).toBe(0o6755);
    os.stage(dirname(f.spec.entry!), f.paths.code);
    expect(statSync(join(`${f.paths.code}.staging`, "tool")).mode & 0o7777).toBe(0o555);
  });
  it("accepts the protected OS shell and rejects user code, mutable lexical symlinks and relative paths", () => {
    const f = fixture(); expect(() => assertRootProtected("/bin/sh")).not.toThrow(); expect(() => assertRootProtected(f.spec.entry!)).toThrow("not root-protected");
    const link = join(f.root, "shell"); symlinkSync("/bin/sh", link); expect(() => assertRootProtected(link)).toThrow("not root-protected");
    const entryLink = join(f.root, "entry-link"); symlinkSync(f.spec.entry!, entryLink); expect(() => assertRootProtected(entryLink)).toThrow("not root-protected");
    expect(() => assertRootProtected("entry.mjs")).toThrow("absolute"); chmodSync(f.root, 0o777); expect(() => assertRootProtected(join(f.root, "missing"))).toThrow("not root-protected");
  });
});

it("system setup applies the observed plan once and changes nothing on a second run", async () => {
  const f = fixture(); const options = { paths: () => f.paths, wait: f.wait, log: () => {} };
  await setupSystem(f.instance.home, f.serviceOS, f.os, options); expect(f.manager.choice(f.spec.key)).toEqual({ registered: true, enabled: true });
  f.changes.length = 0; await setupSystem(f.instance.home, f.serviceOS, f.os, options); expect(f.changes).toEqual([]);
});
it("refuses a cutover without the loaded legacy daemon's rollback plist", () => {
  const f = fixture(); f.states.set(legacyLabel(f.spec.key), { loaded: true, pid: 101 }); expect(f.observe).toThrow("cannot restore");
});

describe("the root-owned runtime", () => {
  it("is what the definition runs, never the user's Node, and the protected walk covers it", () => {
    const f = fixture();
    const machine = systemPaths(f.instance, "vault", "vault.api");
    expect(machine.runtime).toBe(`/usr/local/libexec/barry/${f.instance.id}/runtime/${nodeRuntime().name}`);
    const command = systemDefinition(f.spec, machine).command[0];
    expect(command).toBe(join(machine.runtime, "bin", "node")); expect(command).not.toBe(stableNodePath()); expect(command).not.toContain("/opt/homebrew");
    // A definition prepared before the runtime was pinned is refused rather than run.
    f.definition.command[0] = stableNodePath(); expect(f.observe).toThrow("run `barry setup` first"); f.definition.command[0] = join(f.paths.runtime, "bin", "node");
    f.os.protected = (path) => path !== f.paths.runtime; expect(f.observe).toThrow(`not root-protected: ${f.paths.runtime}`);
  });
  it("refuses a missing or mismatched tarball before any change", async () => {
    const f = fixture(); f.live(); const run = () => setupSystem(f.instance.home, f.serviceOS, f.os, { paths: () => f.paths, wait: f.wait, log: () => {} });
    f.os.fileDigest = () => null; await expect(run()).rejects.toThrow(/run `barry setup` first \(node v.* is not downloaded/);
    f.os.fileDigest = () => "0".repeat(64); await expect(run()).rejects.toThrow(/run `barry setup` first \(.* does not match the pinned SHA-256\)/);
    expect(f.changes).toEqual([]); expect(f.states.get(legacyLabel(f.spec.key))?.loaded).toBe(true);
  });
  it("needs no tarball once the runtime is installed", async () => {
    const f = fixture(); f.live(); f.installRuntime(); f.os.fileDigest = () => { throw new Error("read the tarball"); };
    expect(planSystem(f.observe()).map((a) => a.kind)).toEqual(["stage", "load", "save", "stop-legacy", "swap", "add", "enable", "start", "health", "remove-legacy"]);
  });
  it("proves the staged runtime loads the staged code before the legacy daemon is touched", async () => {
    const f = fixture(); f.live(); const o = f.observe();
    await applySystem(f.manager, o, planSystem(o), f.os, f.serviceOS, f.wait);
    expect(f.changes.slice(0, 4)).toEqual([`directory:${dirname(f.paths.runtime)}`, "stage", "stage-runtime", `load:${basename(f.paths.runtime)}.staging:vault.api.staging`]);
    expect(f.changes.indexOf(`load:${basename(f.paths.runtime)}.staging:vault.api.staging`)).toBeLessThan(f.changes.indexOf(`unload:${legacyLabel(f.spec.key)}`));
  });
  it("refuses a staged runtime that cannot load the code's native modules before the running daemon is touched", async () => {
    const f = fixture(); f.live(); f.os.loadNativeModules = () => { throw new Error("cannot load the native modules"); };
    await expect(setupSystem(f.instance.home, f.serviceOS, f.os, { paths: () => f.paths, wait: f.wait, log: () => {} })).rejects.toThrow("cannot load the native modules");
    expect(f.changes).toEqual([`directory:${dirname(f.paths.runtime)}`, "stage", "stage-runtime"]); expect(f.states.get(legacyLabel(f.spec.key))).toEqual({ loaded: true, pid: 101 });
    expect(existsSync(f.legacy)).toBe(true); expect(existsSync(join(f.instance.home, "services.json"))).toBe(false);
  });
  it("installs the runtime once for services that share it", async () => {
    const f = fixture(); const second: ServiceSpec = { ...f.spec, key: "vault.worker", name: "worker" };
    const secondPaths = { ...f.paths, code: join(f.root, "code", "vault.worker") };
    writeFileSync(join(f.instance.home, "managed-definitions.json"), JSON.stringify([f.definition, systemDefinition(second, secondPaths)]));
    writeFileSync(join(f.instance.home, "service-definitions.json"), JSON.stringify({ [f.spec.key]: f.spec, [second.key]: second }));
    await setupSystem(f.instance.home, f.serviceOS, f.os, { paths: (_instance, _bag, key) => key === second.key ? secondPaths : f.paths, wait: f.wait, log: () => {} });
    expect(f.changes.filter((change) => change === "stage-runtime")).toHaveLength(1);
  });
  // The system service runtime extractor deliberately uses macOS BSD tar flags.
  it.skipIf(process.platform !== "darwin")("stages a verified tarball read-only, keeping its links, and refuses a mismatch before staging", () => {
    const f = fixture(); const os = systemOS(); const name = "node-v0.0.0-darwin-test";
    const source = join(f.root, "tarball", name); mkdirSync(join(source, "bin"), { recursive: true }); mkdirSync(join(source, "lib"));
    writeFileSync(join(source, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 }); writeFileSync(join(source, "lib", "npm.js"), "npm", { mode: 0o644 }); symlinkSync("../lib/npm.js", join(source, "bin", "npm"));
    writeFileSync(join(source, "bin", "helper"), "#!/bin/sh\n"); chmodSync(join(source, "bin", "helper"), 0o4755);
    const tarball = join(f.root, `${name}.tar.gz`); execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", dirname(source), name]);
    const runtime = join(f.root, "runtime", name); mkdirSync(dirname(runtime));
    expect(() => os.stageRuntime(tarball, "0".repeat(64), runtime)).toThrow("does not match the pinned SHA-256"); expect(existsSync(`${runtime}.staging`)).toBe(false);
    os.stageRuntime(tarball, sha256(readFileSync(tarball)), runtime);
    const staged = `${runtime}.staging`;
    expect(statSync(join(staged, "bin", "node")).mode & 0o777).toBe(0o555); expect(statSync(join(staged, "lib", "npm.js")).mode & 0o777).toBe(0o444);
    expect(statSync(join(staged, "bin")).mode & 0o777).toBe(0o755); expect(statSync(join(staged, "bin", "node")).uid).toBe(process.getuid?.());
    expect(lstatSync(join(staged, "bin", "npm")).isSymbolicLink()).toBe(true); expect(statSync(join(staged, "bin", "helper")).mode & 0o7777).toBe(0o555);
    os.swap(runtime); expect(existsSync(join(runtime, "bin", "node"))).toBe(true); expect(existsSync(staged)).toBe(false);
    expect(os.fileDigest(tarball)).toBe(sha256(readFileSync(tarball))); expect(os.fileDigest(join(f.root, "missing.tar.gz"))).toBeNull();
  });
  it("runs the native-module proof as the account and reports a module that does not load", () => {
    const f = fixture(); const os = systemOS(); const account = { uid: process.getuid!(), gid: process.getgid!(), group: "self" };
    const code = join(f.root, "native"); mkdirSync(join(code, "node_modules", "addon"), { recursive: true });
    expect(() => os.loadNativeModules(process.execPath, code, account)).not.toThrow();
    writeFileSync(join(code, "node_modules", "addon", "addon.node"), "not a native module");
    expect(() => os.loadNativeModules(process.execPath, code, account)).toThrow(`cannot load the native modules of ${code}`);
  });
});
