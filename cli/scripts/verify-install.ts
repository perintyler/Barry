/**
 * Run with node --import tsx cli/scripts/verify-install.ts [checkout]. Uses a
 * disposable HOME and BARRY_HOME only, and a recording stand-in for launchd,
 * so it runs on any OS, as any non-root user, without touching an installed
 * Barry. It exercises what the README tells a new user to run:
 *
 *     node cli/bin/barry.js setup --link .
 *
 * up to the point where launchd would start services, then the installed
 * command, a second setup (which must change nothing), the refusals that
 * guard --link, and `barry setup --uninstall` with and without --purge.
 *
 * What it cannot prove: that launchd loads, restarts and stops the jobs. That
 * is cli/scripts/verify-launchd.ts and cli/scripts/acceptance/, on macOS.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.getuid?.() === 0) throw new Error("run verify-install as an ordinary user: barry setup refuses root");

// `--after-purge <checkout>` is this script as its own child: one scenario in
// a fresh process, in the scratch HOME and BARRY_HOME the parent hands down.
const child = process.argv[2] === "--after-purge";
const repo = realpathSync(resolve((child ? process.argv[3] : process.argv[2]) ?? fileURLToPath(new URL("../..", import.meta.url))));
const root = child ? dirname(process.env.BARRY_HOME!) : mkdtempSync(join(tmpdir(), "barry-install-verification-"));
const home = child ? process.env.HOME! : join(root, "home");
const barryHome = child ? process.env.BARRY_HOME! : join(root, "barry-home");
if (!child) {
  mkdirSync(home);
  mkdirSync(barryHome);
  // Everything Barry resolves from the environment must be scratch before any
  // SDK module loads: the instance root, the login directory (where launchd
  // plists go), and no inherited Barry or vendor state.
  for (const key of Object.keys(process.env)) if (key.startsWith("BARRY_") || key.endsWith("API_KEY") || key.endsWith("TOKEN")) delete process.env[key];
  process.env.HOME = home;
  process.env.BARRY_HOME = barryHome;
  process.env.BARRY_OLLAMA_URL = "http://127.0.0.1:1";
  process.env.LOG_LEVEL = "silent";
}

const { setupCommand } = await import("../src/commands/setup.js");
const { uninstallCommand } = await import("../src/commands/uninstall.js");
const { currentInstallation } = await import("../src/releases/current.js");
const { barryAppSupportDir, barryCurrentDir, barryEnvPath, barryCacheDir, barryConfigDir, barryLogsDir, barryReleasesDir } = await import("@barry-rocks/sdk/services");
const { loadBuiltinRegistry } = await import("@barry-rocks/sdk/internal/bags");
type ServiceOS = import("@barry-rocks/mcp-bag").ServiceOS;
type JobState = import("@barry-rocks/mcp-bag").JobState;

/**
 * launchd as a ledger. Policy calls are recorded; nothing is ever loaded or
 * started, because `--no-start` promises exactly that and a verification that
 * started real services would need the whole instance to come up.
 */
function recordingOS() {
  const calls: string[] = [];
  const states = new Map<string, JobState>();
  const refuse = (what: string) => (_domain: string, label: string) => { throw new Error(`setup tried to ${what} ${label} under --no-start`); };
  const os: ServiceOS = {
    inspect: (_domain, label) => states.get(label) ?? { loaded: false },
    load: refuse("load"),
    start: refuse("start"),
    unload: async (_domain, label) => { calls.push(`unload:${label}`); states.set(label, { loaded: false }); },
    enable: (_domain, label, enabled) => { calls.push(`enable:${label}:${enabled}`); },
  };
  return { os, calls };
}

const results: { scenario: string; status: string; details?: unknown }[] = [];
async function scenario(name: string, fn: () => Promise<unknown> | unknown) {
  const details = await fn();
  results.push({ scenario: name, status: "passed", details });
  console.log(`PASS ${name}`);
}
const launchAgents = () => join(home, "Library", "LaunchAgents");
const plists = () => existsSync(launchAgents()) ? readdirSync(launchAgents()).filter(name => name.endsWith(".plist")).sort() : [];
const instanceId = () => (JSON.parse(readFileSync(join(barryAppSupportDir(), "instance.json"), "utf8")) as { id: string }).id;
const shim = () => join(barryHome, "bin", "barry");
/** The installed command, as a shell would run it: only the shim's own path and a PATH that has no node of its own. */
const barry = (...args: string[]) => execFileSync(shim(), args, { encoding: "utf8", env: { HOME: home, BARRY_HOME: barryHome, PATH: "/usr/bin:/bin", LOG_LEVEL: "silent", BARRY_OLLAMA_URL: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"] });

if (child) {
  await setupCommand({ link: repo, start: false, launchd: recordingOS().os });
  const instance = instanceId();
  assert.match(instance, /^[0-9a-f-]{36}$/);
  const count = plists().length;
  assert(count > 0);
  assert.match(barry("--version").trim(), /^\d+\.\d+\.\d+/);
  await uninstallCommand({ yes: true, purge: true, launchd: recordingOS().os, launchAgentsDir: launchAgents(), log: () => {} });
  assert.equal(existsSync(join(barryAppSupportDir(), "instance.json")), false);
  console.log(JSON.stringify({ instance, plists: count }));
  process.exit(0);
}

try {
  await scenario("--link refuses a directory that is not a Barry checkout, and cannot combine with --uninstall", async () => {
    const stray = join(root, "not-a-checkout");
    mkdirSync(stray);
    await assert.rejects(setupCommand({ link: stray, start: false, launchd: recordingOS().os }), /has no identity\.yaml/);
    await assert.rejects(setupCommand({ link: repo, uninstall: true, launchd: recordingOS().os }), /--link cannot be combined/);
    assert.equal(existsSync(barryCurrentDir()), false, "a refused link must not point current anywhere");
    assert.equal(existsSync(shim()), false);
  });

  const first = recordingOS();
  await scenario("setup --link <checkout> --no-start installs the instance from the checkout", async () => {
    const previousPath = process.env.PATH;
    const messages: string[] = [];
    const write = console.log;
    process.env.PATH = "/usr/bin:/bin";
    console.log = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); write(...args); };
    try { await setupCommand({ link: repo, start: false, launchd: first.os }); }
    finally { console.log = write; process.env.PATH = previousPath; }
    assert(messages.includes("No session adapter is installed. Install one, then run: barry adapter add adapters/sessions/<name>"), "a host with no vendor binary receives an actionable selection hint");
    assert(lstatSync(barryCurrentDir()).isSymbolicLink(), "current is a symlink");
    assert.equal(realpathSync(barryCurrentDir()), repo, "current points at the linked checkout");
    const current = currentInstallation();
    assert.equal(current.kind, "link");
    assert.equal(current.target, repo);
    const support = barryAppSupportDir();
    for (const file of ["instance.json", "service-definitions.json", "managed-definitions.json", "bags.snapshot.json", "bag-resources.json", "model-providers.json", "config.db"])
      assert(existsSync(join(support, file)), `${file} exists`);
    assert.match(instanceId(), /^[0-9a-f-]{36}$/);
    assert.equal(statSync(barryEnvPath()).mode & 0o777, 0o600, "the instance secret file is private");
    const snapshot = JSON.parse(readFileSync(join(support, "bags.snapshot.json"), "utf8")) as { bags: Record<string, unknown> };
    const shipped = Object.keys(loadBuiltinRegistry()).sort();
    assert.deepEqual(Object.keys(snapshot.bags).sort(), shipped, "every shipped bag is registered");
    const providers = JSON.parse(readFileSync(join(support, "model-providers.json"), "utf8")) as { installed?: { packageName: string; shipped?: boolean }[] } | { packageName: string }[];
    const installed = Array.isArray(providers) ? providers : providers.installed ?? [];
    const names = installed.map(record => record.packageName).sort();
    assert(names.includes("@barry-rocks/completion-anthropic") && names.includes("@barry-rocks/completion-ollama"), `shipped call code is selected: ${names.join(", ")}`);
    const definitions = JSON.parse(readFileSync(join(support, "service-definitions.json"), "utf8")) as Record<string, unknown>;
    for (const service of ["mcp.server", "sessions.api", "workflows.runtime", "schedules.scheduler", "vault.api"])
      assert(service in definitions, `${service} is declared`);
    const agents = plists();
    assert(agents.length > 0, "launchd registrations were written");
    assert(agents.every(name => name.startsWith(`rocks.barry.${instanceId()}.`)), `every plist carries this instance's id: ${agents.join(", ")}`);
    assert(first.calls.length > 0 && first.calls.every(call => call.startsWith("enable:")), `only policy reached launchd: ${first.calls.join(", ")}`);
    const text = readFileSync(shim(), "utf8");
    assert.equal(statSync(shim()).mode & 0o111, 0o111, "the shim is executable");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert(text.includes("export BARRY_NODE="), "the shim pins the Node that ran setup");
    assert(text.includes(join(barryCurrentDir(), "bin", "barry")), "the shim runs current's bin/barry");
    return { instance: instanceId(), services: Object.keys(definitions).sort(), bags: shipped.length, plists: agents.length, launchd: first.calls };
  });

  await scenario("the installed command runs from the shim without the checkout on PATH", () => {
    const version = barry("--version").trim();
    assert.match(version, /^\d+\.\d+\.\d+/, `version: ${version}`);
    const directVersion = execFileSync(process.execPath, [join(repo, "cli/bin/barry.js"), "--version"], { encoding: "utf8", env: { ...process.env } }).trim();
    assert.equal(version, directVersion, "shim and checkout report the same committed version");
    const listing = JSON.parse(barry("workers", "list", "--json")) as { installation: string; workers: unknown[]; owners: unknown[] };
    assert.match(listing.installation, /^[0-9a-f-]{36}$/);
    assert.deepEqual(listing.workers, []);
    assert.deepEqual(listing.owners, []);
    const bags = barry("bag", "list");
    for (const name of ["sessions", "workflows", "nodes", "mcp"]) assert(bags.includes(`  ${name} `), `bag list names ${name}`);
    const status = barry("workers", "status");
    assert(status.includes("sessions:summarize-session@1"), "the shipped remotable job is known");
    return { version, installation: listing.installation, workersStatus: status.trim().split("\n") };
  });

  await scenario("the shipped remotable job is offered once its bag's bounds are synced", () => {
    // Setup now syncs every shipped job bound; repeating sync preserves it.
    const before = barry("workers", "status");
    assert(!before.includes("unknown bound"), `fresh setup: ${before}`);
    assert(before.includes("model=local"), `fresh setup reports the required label: ${before}`);
    barry("bag", "sync-traits", "sessions");
    const after = barry("workers", "status");
    assert.equal(after, before, "sync-traits is a no-op after setup");
    assert(!after.includes("unknown bound"), `after sync-traits: ${after}`);
    assert(after.includes("sessions:summarize-session@1"));
    return { beforeSync: before.includes("unknown bound") ? "unknown bound (needs sync-traits)" : "known", afterSync: after.trim().split("\n").pop() };
  });

  await scenario("doctor --json --strict names enabled services that were deliberately not started", () => {
    const result = spawnSync(shim(), ["doctor", "--json", "--strict"], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(shim())}:/usr/bin:/bin` } });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as { installation: { name: string; status: string; detail: string }[] };
    for (const name of ["current", "shim", "path", "node", "bounds", "owner", "nodes"]) assert.equal(report.installation.find(check => check.name === name)?.status, "pass", `${name}: ${result.stdout}`);
    assert.equal(report.installation.find(check => check.name === "services")?.status, "fail");
    assert.equal(report.installation.find(check => check.name === "session-adapter")?.status, "fail");
    assert.match(report.installation.find(check => check.name === "session-adapter")?.detail ?? "", /no session adapter selected/);
    return report;
  });

  const second = recordingOS();
  await scenario("a second setup changes nothing: same instance, same registrations, policy only", async () => {
    const id = instanceId();
    const choicesBefore = readFileSync(join(barryAppSupportDir(), "managed-definitions.json"), "utf8");
    const agentsBefore = plists();
    const shimBefore = readFileSync(shim(), "utf8");
    await setupCommand({ start: false, launchd: second.os });
    assert.equal(instanceId(), id);
    assert.equal(realpathSync(barryCurrentDir()), repo);
    assert.deepEqual(plists(), agentsBefore);
    assert.equal(readFileSync(shim(), "utf8"), shimBefore);
    assert.equal(readFileSync(join(barryAppSupportDir(), "managed-definitions.json"), "utf8"), choicesBefore);
    assert(second.calls.every(call => call.startsWith("enable:")), second.calls.join(", "));
    return { launchd: second.calls.length };
  });

  await scenario("an unsupported service host accepts --no-start and refuses startup after registering everything", async () => {
    const { inertServiceOS } = await import("@barry-rocks/mcp-bag");
    const { installedServices } = await import("../src/services/barry.js");
    await assert.rejects(setupCommand({ launchd: inertServiceOS() }), error => error instanceof Error && "reason" in error && error.reason === "unsupported" && /services need launchd or systemd/.test(error.message));
    await setupCommand({ start: false, launchd: inertServiceOS() });
    const services = await (await installedServices({ os: inertServiceOS() })).list();
    assert(services.length > 0);
    assert(services.every(service => service.state === "unsupported"));
    assert(services.filter(service => !service.name.startsWith("vault.")).every(service => service.registered));
    assert(existsSync(shim()));
    return { services: services.length, state: "unsupported" };
  });

  const support = readFileSync(join(repo, "docs/support.md"), "utf8");
  const footprintTable = support.split("<!-- install-footprint:start -->")[1]?.split("<!-- install-footprint:end -->")[0];
  assert(footprintTable, "support documentation declares the verified install footprint");
  const footprintRows = [
    ["app-support", "retained", "removed"], ["stores", "retained", "removed"],
    ["cache", "removed", "removed"], ["current", "removed", "removed"], ["releases", "removed", "removed"],
    ["config", "retained", "removed"], ["logs", "retained", "removed"],
    ["bin directory", "retained", "retained"], ["LaunchAgents directory", "retained", "retained"],
  ];
  for (const row of footprintRows) assert(footprintTable.includes(`| ${row.join(" | ")} |`), `documented footprint agrees with verifier: ${row.join(" / ")}`);
  // Cover every row of docs/support.md, including releases on a linked install.
  mkdirSync(join(barryReleasesDir(), "unused"), { recursive: true });
  writeFileSync(join(barryReleasesDir(), "unused", "marker"), "release bytes");
  for (const directory of [barryCacheDir(), barryConfigDir(), barryLogsDir()]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "contract-marker"), "retention contract");
  }
  await scenario("setup --uninstall --dry-run names what it would remove and removes nothing", async () => {
    const agents = plists();
    const summary = await uninstallCommand({ dryRun: true, yes: true, launchd: recordingOS().os, launchAgentsDir: launchAgents(), log: () => {} });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.plistsRemoved.length, agents.length);
    assert.deepEqual(summary.shimsRemoved, [shim()]);
    assert.deepEqual(plists(), agents);
    assert(existsSync(shim()));
    assert(existsSync(barryCurrentDir()));
    for (const directory of [barryAppSupportDir(), dirname(shim()), barryCacheDir(), barryConfigDir(), barryLogsDir(), launchAgents(), barryReleasesDir()]) assert(existsSync(directory), `dry run keeps ${directory}`);
    return summary;
  });

  await scenario("setup --uninstall removes the registrations and the command, and keeps the data", async () => {
    const os = recordingOS();
    const summary = await uninstallCommand({ yes: true, launchd: os.os, launchAgentsDir: launchAgents(), log: () => {} });
    assert.deepEqual(plists(), []);
    assert.equal(existsSync(shim()), false);
    assert(summary.dataRetained.length > 0, "data is reported retained");
    assert(existsSync(join(barryAppSupportDir(), "instance.json")), "the instance record survives");
    assert(existsSync(join(barryAppSupportDir(), "stores")), "stores survive");
    for (const directory of [barryAppSupportDir(), dirname(shim()), barryConfigDir(), barryLogsDir(), launchAgents()]) assert(existsSync(directory), `uninstall retains ${directory}`);
    for (const path of [barryCacheDir(), barryCurrentDir(), barryReleasesDir()]) assert.equal(existsSync(path), false, `uninstall removes ${path}`);
    const doctor = spawnSync(process.execPath, [join(repo, "cli/bin/barry.js"), "doctor", "--json", "--strict"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(doctor.status, 1, doctor.stderr);
    const health = JSON.parse(doctor.stdout) as { installation: { name: string; status: string }[] };
    for (const name of ["current", "shim", "node"]) assert.equal(health.installation.find(check => check.name === name)?.status, "fail", doctor.stdout);
    // Every registration is booted out of launchd, whether or not it was running.
    assert.equal(os.calls.filter(call => call.startsWith("unload:")).length, summary.servicesUnloaded.length, os.calls.join(", "));
    return { unregistered: summary.servicesUnloaded, retained: summary.dataRetained, caches: summary.cachesRemoved };
  });

  await scenario("setup --uninstall --purge removes the data as well", async () => {
    const summary = await uninstallCommand({ yes: true, purge: true, launchd: recordingOS().os, launchAgentsDir: launchAgents(), log: () => {} });
    assert(summary.purged);
    assert(summary.dataPurged.length > 0);
    assert.equal(existsSync(join(barryAppSupportDir(), "instance.json")), false, "the instance record is gone");
    assert.equal(existsSync(join(barryAppSupportDir(), "stores")), false, "stores are gone");
    for (const path of [barryAppSupportDir(), barryCacheDir(), barryConfigDir(), barryLogsDir(), barryReleasesDir(), barryCurrentDir()]) assert.equal(existsSync(path), false, `purge removes ${path}`);
    for (const directory of [dirname(shim()), launchAgents()]) assert(existsSync(directory), `purge retains shared parent ${directory}`);
    return { purged: summary.dataPurged };
  });

  await scenario("release setup, linked upgrade, release upgrade and rollback preserve stores and receipts", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", join(repo, "cli/scripts/verify-install-release.ts"), repo], { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(output.trim().split("\n").pop()!);
  });

  await scenario("setup after a purge starts a fresh instance from the same checkout", () => {
    // In a new process, as a person would: this one still holds the purged
    // registry open, and a setup here would read the old one through it.
    const output = execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--after-purge", repo], { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
    const line = output.trim().split("\n").pop() ?? "";
    const outcome = JSON.parse(line) as { instance: string; plists: number };
    assert.match(outcome.instance, /^[0-9a-f-]{36}$/);
    assert(outcome.plists > 0);
    assert.equal(existsSync(join(barryAppSupportDir(), "instance.json")), false, "the child purged its instance again");
    return outcome;
  });
} catch (error) {
  results.push({ scenario: "verification", status: "failed", details: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
} finally {
  const report = join(root, "report.json");
  writeFileSync(report, JSON.stringify({ checkout: repo, node: process.version, platform: `${process.platform}-${process.arch}`, results }, null, 2));
  console.log(`Report: ${report}`);
  for (const result of results.filter(entry => entry.status !== "passed")) console.error(`FAIL ${result.scenario}: ${String(result.details)}`);
}
