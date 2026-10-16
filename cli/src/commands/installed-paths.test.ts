import { execFileSync } from "node:child_process";
import { existsSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barryAppSupportDir, barryCurrentDir, barryReleasesDir } from "@barry-rocks/sdk/services";
import { openInstance, stableNodePath } from "@barry-rocks/sdk/internal/services";
import { hookDispatchCommand } from "@barry-rocks/sdk/internal/hooks";
import type { ServiceOS } from "@barry-rocks/mcp-bag";
import type { ServiceDefinition } from "@barry-rocks/mcp-bag";
import type { SystemOS } from "../services/system.js";
import { closeConfigDb } from "../services/configuration/database.js";
import { renderShim } from "../lib/identity-shims.js";
// This fixture ships no session adapters. Do not discover vendor binaries
// from the developer's PATH while pinning installation-path snapshots.
vi.mock("../adapters/setup.js", () => ({ selectShippedSessionAdapters: vi.fn(async () => []) }));
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, owner: { ...actual.owner, installation: () => ({ provision: () => ({ actorId: 2, name: "Owner" }) }) } };
});
vi.mock("../apps/app-build.js", () => ({ discoverBagApps: async () => [] }));
vi.mock("@barry-rocks/mcp-bag", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/mcp-bag")>(),
  waitForServices: vi.fn(),
}));
vi.mock("@barry-rocks/sdk/adapters/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/sdk/adapters/models")>();
  return { ...actual, shippedModelVendors: vi.fn(actual.shippedModelVendors) };
});
vi.mock("../lib/identity-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/identity-commands.js")>();
  return { ...actual, reconcileAllIdentities: vi.fn(actual.reconcileAllIdentities) };
});
import { shippedModelVendors } from "@barry-rocks/sdk/adapters/models";
import { reconcileAllIdentities } from "../lib/identity-commands.js";
import { pointCurrent } from "../releases/current.js";
import { setupCommand } from "./setup.js";
const source = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../releases/release.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../releases/release.js")>();
  return { ...actual, releaseRoot: () => source.root ?? actual.releaseRoot() };
});
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
let scratch: string;
const os: ServiceOS = { inspect: vi.fn(() => ({ loaded: false })), load: vi.fn(), unload: vi.fn(async () => {}), enable: vi.fn(), start: vi.fn() };
const refuse = (): never => { throw new Error("unexpected system operation"); };
const systemOS: SystemOS = {
  uid: refuse, sudoUid: refuse, owner: refuse, account: refuse, ids: refuse, member: refuse,
  exists: refuse, read: refuse, digest: refuse, fileDigest: refuse, protected: refuse, stateParent: refuse,
  environmentNames: refuse, createAccount: refuse, addMember: refuse, directory: refuse, stage: refuse,
  stageRuntime: refuse, loadNativeModules: refuse, swap: refuse, restore: refuse, saveLegacy: refuse, remove: refuse, writePlist: refuse,
};
function put(root: string, name: string, content: string, mode = 0o644): void {
  const path = join(root, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
}
function fixture(root: string, release = false): void {
  put(root, "identity.yaml", "name: Barry\nbags: [fixture]\n");
  put(root, "bags/fixture/bag.yaml", `name: fixture
description: Installed paths fixture
services:
  source:
    description: Source service
    entry: src/main.ts
  built:
    description: Built service
    entry: dist/main.js
hooks:
  - event: session-start
    run: hooks/start.sh
`);
  put(root, "bags/fixture/src/main.ts", "export {};\n");
  put(root, "bags/fixture/dist/main.js", "console.log('service');\n");
  put(root, "bags/fixture/hooks/start.sh", "#!/bin/sh\nexit 0\n", 0o755);
  put(root, "node_modules/tsx/dist/loader.mjs", "");
  put(root, "sdk/package.json", '{"name":"@barry-rocks/sdk","version":"0.0.0-test"}');
  put(root, "adapters/completions/alpha/package.json", JSON.stringify({ name: "alpha", version: "1.0.0", type: "module", exports: "./index.js", barry: { modelProvider: { contractVersion: 1, factoryExport: "FACTORIES" } } }));
  put(root, "adapters/completions/alpha/index.js", "export const FACTORIES = { completion: { alpha: () => ({}) } };\n");
  for (const program of ["barry", "barry-service", "barry-hook"]) {
    put(root, `cli/bin/${program}.js`, 'console.log(JSON.stringify({ argv: process.argv.slice(2), BARRY_DIR: process.env.BARRY_DIR, BARRY_BUILTIN_DIR: process.env.BARRY_BUILTIN_DIR }));\n');
    mkdirSync(join(root, "bin"), { recursive: true });
    cpSync(join(repo, "bin", program), join(root, "bin", program));
  }
  if (release) {
    mkdirSync(join(root, "runtime/bin"), { recursive: true });
    symlinkSync(process.execPath, join(root, "runtime/bin/node"));
    put(root, "release.json", JSON.stringify({ version: "0.0.0-test", commit: "1".repeat(40), platform: "darwin-arm64", node: { version: process.versions.node, sha256: "2".repeat(64) }, stores: {}, built: "2026-10-08T00:00:00.000Z" }));
  }
}
function collect(): Record<string, string> {
  const home = barryAppSupportDir();
  const id = openInstance(home).id;
  const files: Record<string, string> = { "barry.sh": readFileSync(join(process.env.BARRY_HOME!, "bin/barry"), "utf8") };
  for (const name of ["managed-definitions.json", "service-definitions.json", "bag-resources.json"])
    files[name] = readFileSync(join(home, name), "utf8");
  if (existsSync(join(home, "model-providers.json"))) files["model-providers.json"] = readFileSync(join(home, "model-providers.json"), "utf8");
  files["bags.snapshot.json"] = readFileSync(process.env.BARRY_BAGS_SNAPSHOT!, "utf8");
  const plists = join(process.env.HOME!, "Library/LaunchAgents");
  for (const name of readdirSync(plists)) files[name.replace(id, "INSTANCE")] = readFileSync(join(plists, name), "utf8");
  files["identity.sh"] = renderShim("bux", "unused", { id: 7, home: process.env.BARRY_HOME!, instance: id });
  const definitions = JSON.parse(files["managed-definitions.json"]) as ServiceDefinition[];
  process.env.BARRY_HOOK_DISPATCHER = definitions[0].environment!.BARRY_HOOK_DISPATCHER;
  files["hook.txt"] = hookDispatchCommand() + "\n";
  return files;
}
function normalize(text: string): string {
  const id = openInstance(barryAppSupportDir()).id;
  text = text.replace(/((?:"PATH": "|<key>PATH<\/key><string>))[^:]+:/g, "$1<NODE_DIR>:");
  text = text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TIME>");
  for (const [path, name] of [[stableNodePath(), "<NODE>"], [realpathSync(scratch), "<SCRATCH>"], [scratch, "<SCRATCH>"], [repo, "<ROOT>"]])
    text = text.split(pathToFileURL(path).href).join(name).split(path).join(name);
  return text.split(id).join("<INSTANCE>").split(String(process.getuid?.())).join("<UID>");
}
beforeEach(() => {
  source.root = undefined;
  scratch = mkdtempSync(join(tmpdir(), "barry home "));
  vi.stubEnv("HOME", join(scratch, "home"));
  vi.stubEnv("BARRY_HOME", join(scratch, "instance"));
  vi.stubEnv("BARRY_CONFIG_DB", join(scratch, "config.db"));
  vi.stubEnv("BARRY_BAGS_SNAPSHOT", join(scratch, "bags.snapshot.json"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(scratch, "identities.db"));
  for (const key of ["BARRY_DIR", "BARRY_BUILTIN_DIR", "BARRY_HOOK_DISPATCHER", "BARRY_NODE"]) vi.stubEnv(key, undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(reconcileAllIdentities).mockReset().mockResolvedValue(null);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  closeConfigDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});
describe("installed paths", () => {
  it("pins checkout setup output without current", async () => {
    const root = join(scratch, "checkout");
    fixture(root);
    vi.stubEnv("BARRY_BUILTIN_DIR", join(root, "bags"));
    vi.mocked(shippedModelVendors).mockReturnValueOnce([]);
    await setupCommand({ launchd: os, systemOS, start: false });
    const files = collect();
    expect(Object.keys(files).filter(name => name.endsWith(".plist"))).toHaveLength(2);
    expect(vi.mocked(reconcileAllIdentities)).not.toHaveBeenCalled();
    // Shipped model vendors are recorded from this root's adapters, joined as given.
    expect(vi.mocked(shippedModelVendors).mock.lastCall).toEqual([repo]);
    expect(statSync(join(process.env.BARRY_HOME!, "bin/barry")).mode & 0o777).toBe(0o755);
    for (const [name, text] of Object.entries(files)) await expect(normalize(text)).toMatchFileSnapshot(`__golden__/installed-checkout/${name}`);
  });
});

function xmlWords(text: string): string[] {
  return [...text.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!));
}
for (const kind of ["release", "link"] as const) {
  it(`writes runnable commands through current for a ${kind}`, async () => {
    const root = kind === "release" ? join(barryReleasesDir(), "0.0.0-test") : join(scratch, "my checkout");
    fixture(root, kind === "release");
    if (kind === "release") pointCurrent(root);
    else {
      const node = join(scratch, "node");
      symlinkSync(process.execPath, node);
      vi.stubEnv("BARRY_NODE", node);
    }
    vi.stubEnv("BARRY_SECRET", "e3a-test-secret-must-not-leak");
    await setupCommand({ launchd: os, systemOS, start: false, ...(kind === "link" ? { link: root } : {}) });
    const current = barryCurrentDir();
    const identity = join(process.env.BARRY_HOME!, "bin/zzinstalled");
    writeFileSync(identity, renderShim("zzinstalled", "unused", { id: 7, home: process.env.BARRY_HOME!, instance: openInstance(barryAppSupportDir()).id }), { mode: 0o755 });
    const files = collect();
    files["zzinstalled.sh"] = readFileSync(identity, "utf8");
    const combined = Object.values(files).join("\n");
    for (const forbidden of [root, realpathSync(root), repo, "/Cellar/barry/", process.env.BARRY_SECRET!]) {
      expect(combined).not.toContain(forbidden);
      expect(combined).not.toContain(pathToFileURL(forbidden).href);
    }
    expect(files["barry.sh"]).toContain(join(current, "bin/barry"));
    const definitions = JSON.parse(files["managed-definitions.json"]) as ServiceDefinition[];
    const dispatcher = join(current, kind === "release" ? "bin/barry-hook" : "cli/bin/barry-hook.js");
    const specs = JSON.parse(files["service-definitions.json"]) as Record<string, { cwd: string }>;
    expect(Object.values(specs).every(spec => spec.cwd.startsWith(join(current, "bags") + "/"))).toBe(true);
    const providers = JSON.parse(files["model-providers.json"]) as Array<{ path: string }>;
    expect(files["model-providers.json"]).toContain(join(current, "adapters"));
    expect(providers.map(provider => provider.path)).toEqual([join(current, "adapters/completions/alpha")]);
    expect(JSON.parse(files["bags.snapshot.json"]).bags.fixture.path).toBe(join(current, "bags/fixture"));
    for (const definition of definitions) {
      expect(definition.environment!.PATH.split(":")).toEqual([dirname(stableNodePath()), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
      expect(definition.command[0]).toBe(join(current, "bin/barry-service"));
      expect(definition.environment!.BARRY_HOOK_DISPATCHER).toBe(dispatcher);
    }
    const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME! };
    for (const command of [join(process.env.BARRY_HOME!, "bin/barry"), identity]) {
      const result = JSON.parse(execFileSync(command, ["a b", "c"], { env, encoding: "utf8" }));
      expect(result.BARRY_DIR).toBe(current);
      expect(result.argv.slice(-2)).toEqual(["a b", "c"]);
    }
    for (const [name, text] of Object.entries(files).filter(([name]) => name.endsWith(".plist"))) {
      const args = xmlWords(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(text)![1]);
      const environment = /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(text)![1];
      const entries = [...environment.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)];
      const plistEnv = Object.fromEntries(entries.map(match => [match[1], xmlWords(`<string>${match[2]}</string>`)[0]]));
      expect(Object.keys(plistEnv).sort(), name).toEqual(["HOME", "PATH", "BARRY_HOME", "BARRY_DIR", "BARRY_HOOK_DISPATCHER", ...(kind === "link" ? ["BARRY_NODE"] : [])].sort());
      expect(JSON.parse(execFileSync(args[0], args.slice(1), { env: plistEnv, encoding: "utf8" })).BARRY_DIR).toBe(current);
    }
    expect(() => execFileSync("/bin/sh", ["-c", `${files["hook.txt"].trim()} fixture session-start 0`], { env })).not.toThrow();
    expect(reconcileAllIdentities).toHaveBeenCalledOnce();
    expect(statSync(join(process.env.BARRY_HOME!, "bin/barry")).mode & 0o777).toBe(0o755);
    await setupCommand({ launchd: os, systemOS, start: false });
    expect({ ...collect(), "zzinstalled.sh": readFileSync(identity, "utf8") }).toEqual(files);
    for (const [name, text] of Object.entries(files)) await expect(normalize(text)).toMatchFileSnapshot(`__golden__/installed-${kind}/${name}`);
  });
}

it("installs the running release as current on its first setup", async () => {
  source.root = join(scratch, "source release");
  fixture(source.root, true);
  await setupCommand({ launchd: os, systemOS, start: false });
  expect(realpathSync(barryCurrentDir())).toBe(realpathSync(join(barryReleasesDir(), "0.0.0-test")));
  expect(process.env.BARRY_DIR).toBe(barryCurrentDir());
  expect(reconcileAllIdentities).toHaveBeenCalledOnce();
});
it("refuses incompatible link options and a dangling selector, then repairs the selector", async () => {
  const root = join(scratch, "checkout");
  fixture(root);
  for (const extra of [{ system: true }, { uninstall: true }, { dryRun: true }])
    await expect(setupCommand({ launchd: os, systemOS, link: root, ...extra })).rejects.toThrow("--link cannot be combined");
  pointCurrent(join(scratch, "gone"));
  await expect(setupCommand({ launchd: os, systemOS, start: false })).rejects.toThrow("which does not exist");
  await setupCommand({ launchd: os, systemOS, link: root, start: false });
  expect(realpathSync(barryCurrentDir())).toBe(realpathSync(root));
});

it("leaves the Homebrew-owned barry command untouched during setup", async () => {
  const root = join(scratch, "checkout");
  fixture(root);
  vi.stubEnv("BARRY_BUILTIN_DIR", join(root, "bags"));
  vi.mocked(shippedModelVendors).mockReturnValueOnce([]);
  const keg = join(scratch, "Cellar/barry/0.1.0/libexec/bin/barry");
  put(scratch, "Cellar/barry/0.1.0/libexec/bin/barry", "Homebrew", 0o755);
  const dir = join(process.env.BARRY_HOME!, "bin");
  mkdirSync(dir, { recursive: true });
  symlinkSync(keg, join(dir, "barry"));
  await setupCommand({ launchd: os, systemOS, start: false });
  expect(readlinkSync(join(dir, "barry"))).toBe(keg);
  expect(readFileSync(keg, "utf8")).toBe("Homebrew");
});
