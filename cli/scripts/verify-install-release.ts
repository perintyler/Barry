/** Child-process release lifecycle scenarios for verify-install.ts. Service OS is a ledger. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceOS } from "@barry-rocks/mcp-bag";

const repo = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "barry-release-lifecycle-"));
for (const key of Object.keys(process.env)) if (key.startsWith("BARRY_")) delete process.env[key];
process.env.HOME = join(root, "home");
process.env.BARRY_HOME = join(root, "instance");
process.env.LOG_LEVEL = "silent";
process.env.BARRY_OLLAMA_URL = "http://127.0.0.1:1";
mkdirSync(process.env.HOME, { recursive: true });
const os: ServiceOS = { inspect: () => ({ loaded: false }), enable: () => {}, load: () => { throw new Error("release test started services"); }, start: () => { throw new Error("release test started services"); }, unload: async () => {} };

// Like release-home.ts and build.test.ts: metadata and runtime are the production
// shape; external dependencies use the built checkout rather than another install.
const { storeSchemas } = await import("../src/releases/schemas.js");
const { nodeRuntime, downloadRuntime, runtimeTarball, sha256 } = await import("../src/services/runtime.js");
const { barryAppSupportDir, barryCurrentDir, barryStoresDir } = await import("@barry-rocks/sdk/services");
const { currentInstallation } = await import("../src/releases/current.js");
const { readReceipts } = await import("../src/releases/receipts.js");
const { upgradeCommand } = await import("../src/releases/upgrade.js");
const { setupCommand } = await import("../src/commands/setup.js");
const stores = storeSchemas(repo);
const pin = nodeRuntime();
let archive: string | undefined;
if (process.platform === "darwin") {
  await downloadRuntime();
  archive = runtimeTarball();
  assert.equal(sha256(readFileSync(archive)), pin.sha256, "macOS fixtures use the verified real runtime tarball");
}
function release(version: string, commit: string) {
  const directory = join(root, `source-${version}`);
  mkdirSync(directory);
  for (const name of ["cli", "bin", "identity.yaml", "package.json"]) cpSync(join(repo, name), join(directory, name), { recursive: true, verbatimSymlinks: true });
  for (const name of ["bags", "sdk", "adapters", "node_modules"]) symlinkSync(join(repo, name), join(directory, name));
  mkdirSync(join(directory, "runtime/bin"), { recursive: true });
  if (archive) {
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", join(directory, "runtime")]);
    cpSync(archive, join(directory, "runtime", `${pin.name}.tar.gz`));
  } else {
    // Linux fixtures keep the supported release metadata and use the host runtime.
    cpSync(process.execPath, join(directory, "runtime/bin/node"));
  }
  const metadata = { version, commit, platform: "darwin-arm64" as const, node: { version: pin.version, sha256: pin.sha256 }, stores, built: "2026-10-08T00:00:00.000Z" };
  writeFileSync(join(directory, "release.json"), JSON.stringify(metadata));
  writeFileSync(join(directory, "cli/version.json"), JSON.stringify({ version }));
  return { root: directory, release: metadata };
}
function digest(directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (path: string, relative = "") => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const key = join(relative, entry.name), file = join(path, entry.name);
      if (entry.isDirectory()) walk(file, key);
      else if (entry.isFile()) hashes[key] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  walk(directory);
  return hashes;
}
const a = release("91.0.0", "a".repeat(40));
const b = release("91.0.1", "b".repeat(40));
const services = { statuses: async () => [], isSystem: () => false, stop: async () => {}, start: async () => {} };
const run = async (_program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
  assert.deepEqual(args, args[0] === "setup" ? ["setup", "--no-start"] : ["bag", "build", "--force"]);
  if (args[0] !== "setup") return; // Package builds are covered by the package lane.
  for (const name of ["BARRY_DIR", "BARRY_BUILTIN_DIR", "BARRY_NODE", "BARRY_HOOK_DISPATCHER"]) delete process.env[name];
  Object.assign(process.env, Object.fromEntries(Object.entries(options.env).filter(([key]) => key === "BARRY_NODE")));
  await setupCommand({ start: false, launchd: os });
};
const options = { yes: true, services, run, runningSessions: async () => [], waitForHealth: async () => {} };
try {
  // Inject only the source location, like upgrade’s release dependency. Actual
  // setup still stages/copies current, writes the shim, seeds stores and registers.
  await setupCommand({ releaseRoot: a.root, start: false, launchd: os });
  assert.equal(currentInstallation().version, a.release.version);
  assert(currentInstallation().target?.endsWith(`releases/${a.release.version}`));
  assert.equal(execFileSync(join(process.env.BARRY_HOME!, "bin/barry"), ["--version"], { encoding: "utf8" }).trim(), a.release.version);
  const doctor = spawnSync(join(process.env.BARRY_HOME!, "bin/barry"), ["doctor", "--json", "--strict"], { encoding: "utf8", env: { ...process.env, PATH: `${join(process.env.BARRY_HOME!, "bin")}:/usr/bin:/bin` } });
  assert.equal(doctor.status, 1, doctor.stderr); // no-start intentionally leaves enabled services stopped.
  const health = JSON.parse(doctor.stdout) as { installation: { name: string; status: string }[] };
  assert.equal(health.installation.find(check => check.name === "node")?.status, "pass", doctor.stdout);
  // Then exercise the developer checkout's supported switch into the channel.
  await setupCommand({ link: repo, start: false, launchd: os });
  const { installationRegistry } = await import("@barry-rocks/sdk/internal/nodes");
  const registry = installationRegistry();
  registry.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = digest(barryStoresDir());
  assert(Object.keys(before).length > 0, "setup produced store files");
  for (const candidate of [a, b]) {
    await upgradeCommand({ ...options, release: candidate });
    assert.equal(currentInstallation().version, candidate.release.version);
    assert.equal(execFileSync(join(process.env.BARRY_HOME!, "bin/barry"), ["--version"], { encoding: "utf8" }).trim(), candidate.release.version);
    assert.deepEqual(digest(barryStoresDir()), before, "code-only switch preserves every store file");
    const receipt = readReceipts()[0];
    assert.equal(receipt.state, "complete");
    assert.equal(receipt.to.kind, "release");
    assert.equal(receipt.to.kind === "release" && receipt.to.version, candidate.release.version);
    assert(existsSync(receipt.snapshot!));
    if (candidate === a) {
      assert.equal(receipt.from.kind, "link");
      await upgradeCommand({ ...options, rollback: true, release: a });
      assert.equal(currentInstallation().kind, "link");
      assert.equal(currentInstallation().target, repo);
      assert.deepEqual(digest(barryStoresDir()), before, "rollback to checkout preserves every store file");
      assert.equal(readReceipts()[0].kind, "rollback");
      assert.equal(readReceipts()[0].state, "complete");
      await upgradeCommand({ ...options, release: a });
      assert.equal(currentInstallation().version, a.release.version);
      assert.deepEqual(digest(barryStoresDir()), before);
    } else {
      assert.equal(receipt.from.kind === "release" && receipt.from.version, a.release.version);
    }
  }
  await upgradeCommand({ ...options, rollback: true, release: b });
  assert.equal(currentInstallation().version, a.release.version);
  assert.equal(execFileSync(join(process.env.BARRY_HOME!, "bin/barry"), ["--version"], { encoding: "utf8" }).trim(), a.release.version);
  assert.deepEqual(digest(barryStoresDir()), before, "rollback preserves every store file");
  assert.equal(readReceipts()[0].kind, "rollback");
  assert.equal(readReceipts()[0].state, "complete");
  console.log(JSON.stringify({ freshRelease: a.release.version, linkedUpgrade: a.release.version, linkedRollback: repo, releaseUpgrade: b.release.version, rollback: a.release.version, storeFiles: Object.keys(before).length, receipts: readReceipts().length, current: barryCurrentDir(), support: barryAppSupportDir() }));
} finally {
  // Dependencies may hold scratch store handles; macOS/Linux can unlink them.
  rmSync(root, { recursive: true, force: true });
}
