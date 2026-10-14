/** Real OS acceptance. Every mutation is scoped to an explicit, owned fixture root. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { openInstance, type Instance, nodeTsArgv } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, type ServiceDefinition } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";
import { rotateLog, tailLog } from "@barry-rocks/mcp-bag";


interface Receipt {
  version: 1; root: string; uid: number; instances: Instance[];
  definitions: ServiceDefinition[][]; results: Array<{ scenario: string; at: string; evidence?: unknown }>;
  triggers?: { boot: string; session: string; phase: "login" | "boot" };
}
const [mode, rawRoot, event] = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("real service acceptance requires macOS");
if (!rawRoot || !["run", "cleanup", "prepare-triggers", "resume-triggers"].includes(mode))
  throw new Error("usage: verify-services.ts run|cleanup|prepare-triggers|resume-triggers <absolute-fixture-root> [login|boot]");
if (!rawRoot.startsWith("/")) throw new Error("fixture root must be absolute");
const root = resolve(rawRoot), path = join(root, "acceptance.json"), uid = process.getuid!();
if (["/", homedir(), barryAppSupportDir()].includes(root))
  throw new Error("refusing an installation or home as fixture root");
const os = launchd();
let receipt: Receipt;
if (existsSync(path)) {
  receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.version !== 1 || receipt.root !== root || receipt.uid !== uid || receipt.instances.some(instance => !instance.home.startsWith(root + "/")))
    throw new Error("fixture ownership mismatch");
  for (const [index, instance] of receipt.instances.entries()) {
    assert.equal(JSON.parse(readFileSync(join(instance.home, "instance.json"), "utf8")).id, instance.id);
    assert.ok(receipt.definitions[index].every(definition => definition.name === "fixture.worker" && definition.domain === `gui/${uid}` && definition.logDirectory.startsWith(root + "/")));
  }
} else {
  if (mode !== "run" && mode !== "prepare-triggers") throw new Error("no owned acceptance receipt");
  if (existsSync(root)) throw new Error("new acceptance root must not already exist");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  receipt = { version: 1, root, uid, instances: [], definitions: [], results: [] };
}
const save = () => writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const passed = (scenario: string, evidence?: unknown) => { receipt.results.push({ scenario, at: new Date().toISOString(), evidence }); save(); console.log(`PASS ${scenario}`); };
const managers = () => receipt.instances.map((instance, index) => new ServiceManagement(instance, receipt.definitions[index], os));
const port = async () => { const s = createServer(); await new Promise<void>(done => s.listen(0, "127.0.0.1", done)); const n = (s.address() as { port: number }).port; await new Promise<void>(done => s.close(() => done())); return n; };
const wait = async (manager: ServiceManagement, name: string, oldPid?: number) => {
  const deadline = Date.now() + 20000;
  do {
    const state = await manager.status(name);
    if (state.pid && state.pid !== oldPid) {
      const address = manager.definition(name).health!;
      try { const response = await fetch(address, { signal: AbortSignal.timeout(500) }); if (response.ok) { const body = await response.json(); assert.equal(body.pid, state.pid); return state; } } catch { /* Readiness may be pending while launchd starts the fixture. */ }
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${name} did not become ready`);
};
const addFixture = async (suffix: string, login = false) => {
  const instance = openInstance(join(root, suffix, "app-support"));
  const p = await port(), directory = join(root, suffix);
  const definition: ServiceDefinition = {
    name: "fixture.worker", command: [process.execPath, fileURLToPath(new URL("./fixtures/service.mjs", import.meta.url)), directory, String(p)],
    directory, domain: `gui/${uid}`,
    plistDirectory: login ? join(homedir(), "Library", "LaunchAgents") : join(directory, "plists"),
    logDirectory: join(directory, "logs"), health: `http://127.0.0.1:${p}/health`,
    environment: { PATH: dirname(process.execPath), BARRY_HOME: directory, ACCEPTANCE_DECLARED: "fixture" }, shutdownMs: 5000,
  };
  writeFileSync(join(instance.home, "service-definitions.json"), JSON.stringify({ [definition.name]: {
    key: definition.name, bag: "barry", name: "worker", command: definition.command[0], args: definition.command.slice(1), cwd: directory,
    env: [{ name: "ACCEPTANCE_DECLARED", source: "value", value: "fixture" }],
  } }), { mode: 0o600 });
  definition.command = [...nodeTsArgv(fileURLToPath(new URL("../../src/services/entry.ts", import.meta.url))), instance.home, definition.name];
  receipt.instances.push(instance); receipt.definitions.push([definition]); save();
  return new ServiceManagement(instance, [definition], os);
};
const cleanup = async () => {
  for (const manager of managers()) for (const definition of receipt.definitions[receipt.instances.findIndex(instance => instance.id === manager.instance.id)]) {
    await manager.apply(definition.name, "remove");
    assert.equal((await manager.status(definition.name)).loaded, false);
    assert.equal(existsSync(join(definition.plistDirectory, `${manager.label(definition.name)}.plist`)), false);
  }
  passed("cleanup: owned registrations absent; fixture receipts retained");
};
const boot = () => execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
const session = () => /\basid = (\d+)/.exec(execFileSync("/bin/launchctl", ["print", `gui/${uid}`], { encoding: "utf8" }))?.[1] ?? "unknown";

if (mode === "cleanup") await cleanup();
else if (mode === "prepare-triggers") {
  if (receipt.instances.length) throw new Error("trigger preparation needs a new fixture root");
  for (const name of ["enabled", "disabled", "removed", "stopped-enabled"]) {
    const manager = await addFixture(name, true);
    await manager.apply("fixture.worker", "add");
    if (name === "enabled" || name === "stopped-enabled") await manager.apply("fixture.worker", "enable", { now: true });
    if (name === "removed") await manager.apply("fixture.worker", "remove");
    if (name === "stopped-enabled") await manager.apply("fixture.worker", "stop");
  }
  receipt.triggers = { boot: boot(), session: session(), phase: "login" }; save();
  passed("trigger fixtures prepared", receipt.triggers);
  console.log("Log out/login in the designated disposable account, then resume-triggers <root> login. This command does not initiate logout.");
} else if (mode === "resume-triggers") {
  if (!receipt.triggers || event !== receipt.triggers.phase) throw new Error("unexpected trigger phase");
  if (event === "boot") assert.notEqual(boot(), receipt.triggers.boot, "actual reboot required");
  else { assert.notEqual(session(), "unknown"); assert.notEqual(session(), receipt.triggers.session, "actual GUI login session change required"); }
  for (let index = 0; index < receipt.instances.length; index++) {
    const manager = managers()[index], name = receipt.instances[index].home.split("/").at(-2);
    if (name === "enabled" || name === "stopped-enabled") await wait(manager, "fixture.worker");
    else assert.equal((await manager.status("fixture.worker")).pid, undefined);
  }
  passed(`actual ${event} triggers`, { boot: boot(), session: session() });
  if (event === "login") {
    for (let index = 0; index < receipt.instances.length; index++) if (receipt.instances[index].home.includes("/stopped-enabled/")) await managers()[index].apply("fixture.worker", "stop");
    receipt.triggers = { boot: boot(), session: session(), phase: "boot" }; save();
    console.log("Reboot the designated disposable environment, log in, then resume-triggers <root> boot.");
  } else await cleanup();
} else {
  if (receipt.instances.length) throw new Error("run needs a new fixture root; use cleanup to recover an interrupted run");
  try {
    const first = await addFixture("first"), second = await addFixture("second");
    await first.apply("fixture.worker", "add"); await first.apply("fixture.worker", "enable");
    assert.equal((await first.status("fixture.worker")).pid, undefined);
    await first.apply("fixture.worker", "disable"); await first.apply("fixture.worker", "start");
    let state = await wait(first, "fixture.worker"); assert.equal(state.enabled, false);
    passed("inert add/enable; disabled manual start; direct owned PID", { label: state.label, pid: state.pid });
    await second.apply("fixture.worker", "add"); await second.apply("fixture.worker", "start");
    const other = await wait(second, "fixture.worker"); assert.notEqual(other.pid, state.pid); assert.notEqual(other.label, state.label);
    passed("two live instances with identical service names", { labels: [state.label, other.label], pids: [state.pid, other.pid] });
    const previousPid = state.pid;
    await fetch(first.definition("fixture.worker").health!.replace("/health", "/crash"), { method: "POST" });
    state = await wait(first, "fixture.worker", previousPid); assert.equal(state.enabled, false);
    passed("kept-alive crash restart preserves disabled automatic policy", { before: previousPid, after: state.pid, runs: state.runs });
    await first.apply("fixture.worker", "enable"); await first.apply("fixture.worker", "disable"); assert.ok((await first.status("fixture.worker")).pid);
    passed("policy-only enable/disable leaves current process running");
    const before = performance.now(); await first.apply("fixture.worker", "stop");
    assert.ok(performance.now() - before >= 200); await delay(1200); assert.equal((await first.status("fixture.worker")).loaded, false);
    assert.equal((await second.status("fixture.worker")).pid, other.pid);
    passed("graceful bounded stop without restart; other instance unaffected");
    writeFileSync(join(first.instance.home, "managed-definitions.json"), JSON.stringify(receipt.definitions[0]), { mode: 0o600 });
    writeFileSync(join(root, "first", "bag.yaml"), "name: acceptance\ndescription: Disposable service fixture\n");
    writeFileSync(join(first.instance.home, "bags.snapshot.json"), JSON.stringify({ bags: { acceptance: { type: "local", path: join(root, "first") } } }), { mode: 0o600 });
    writeFileSync(join(first.instance.home, "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: { "fixture.worker": { bag: "fixture", name: "worker", kind: "service", url: first.definition("fixture.worker").health!.replace("/health", "") } } }), { mode: 0o600 });
    const cli = nodeTsArgv(fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)));
    const listed = execFileSync(cli[0], [...cli.slice(1), "service", "status", "--json"], {
      env: { PATH: process.env.PATH, HOME: homedir(), BARRY_HOME: join(root, "first"), BARRY_CONFIG_ALLOW_EMPTY: "1", BARRY_IDENTITIES_DB: join(root, "first", "identities.db"), BARRY_CONFIG_DB: join(root, "first", "config.db") },
      encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(listed).services[0].state, "stopped");
    passed("real system CLI inspects stopped services with no engine or API running");
    await first.apply("fixture.worker", "enable", { now: true }); await wait(first, "fixture.worker");
    await first.apply("fixture.worker", "disable", { now: true }); assert.equal((await first.status("fixture.worker")).loaded, false);
    passed("enable-now and disable-now");
    const command = first.definition("fixture.worker").command;
    const foreground = spawn(command[0], command.slice(1), { env: { PATH: process.env.PATH, BARRY_HOME: join(root, "first"), ACCEPTANCE_UNDECLARED: "must-not-leak" }, stdio: "pipe" });
    const exited = new Promise<void>((done, reject) => { foreground.once("error", reject); foreground.once("exit", () => done()); });
    try {
      const deadline = Date.now() + 20000;
      let live = false;
      while (Date.now() < deadline) {
        try { const response = await fetch(first.definition("fixture.worker").health!, { signal: AbortSignal.timeout(500) }); live = response.ok && (await response.json()).pid === foreground.pid; } catch { /* Await the foreground entry's same-PID handoff. */ }
        if (live) break; await delay(100);
      }
      assert.ok(live, "foreground entry must own the listener in its original PID");
      await assert.rejects(first.apply("fixture.worker", "start"), /outside launchd/);
      const duplicate = spawn(command[0], command.slice(1), { env: { PATH: process.env.PATH }, stdio: "pipe" });
      let error = ""; duplicate.stderr.on("data", data => { error += data; });
      assert.notEqual(await new Promise<number | null>(done => duplicate.once("exit", done)), 0);
      assert.match(error, /in use by pid/);
      passed("foreground exec handoff keeps PID; foreground/background and duplicate foreground activation refused");
    } finally { foreground.kill("SIGTERM"); await exited; }
    const log = join(first.definition("fixture.worker").logDirectory, "fixture.worker.out.log");
    writeFileSync(log, "x".repeat(1200000) + "\nfixture tail\n"); assert.ok(tailLog(log, 5).length < 1100000);
    rotateLog(log); assert.ok(existsSync(log + ".1"));
    for (let n = 0; n < 4; n++) { writeFileSync(log, `archive ${n}\n`); rotateLog(log); }
    assert.ok(existsSync(log + ".3")); assert.equal(existsSync(log + ".4"), false);
    await first.apply("fixture.worker", "start"); await wait(first, "fixture.worker"); await first.apply("fixture.worker", "stop");
    assert.ok(tailLog(log, 100).includes("archive"));
    passed("bounded log tail; stopped rotation retains three archives; restart writes current log");
    await first.apply("fixture.worker", "remove");
    const reconstructed = new ServiceManagement(first.instance, receipt.definitions[0], os);
    assert.equal(reconstructed.choice("fixture.worker").registered, false);
    await reconstructed.apply("fixture.worker", "add"); assert.equal((await reconstructed.status("fixture.worker")).pid, undefined);
    passed("removal survives manager reconstruction; explicit re-add is inert");
    const events = readFileSync(join(root, "first", "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(entry => entry.event === "drain"));
    assert.ok(events.filter(entry => entry.event === "start").every(entry => !entry.environment.includes("BARRY_SECRET")));
    assert.ok(events.filter(entry => entry.event === "start").every(entry => !entry.environment.includes("ACCEPTANCE_UNDECLARED")));
    passed("declared environment and observable shutdown", { starts: events.filter(entry => entry.event === "start").length });
  } finally { await cleanup(); }
}
