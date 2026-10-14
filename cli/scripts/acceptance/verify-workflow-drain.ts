/** Exercise the real workflow application and noncooperative child through launchd. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openInstance, nodeTsArgv } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";

const rawRoot = process.argv[2];
const mode = process.argv[3];
if (mode !== undefined && mode !== "full-budget") throw new Error("optional mode is full-budget");
const drainBudget = mode === "full-budget" ? 30000 : 500;
if (process.platform !== "darwin" || !rawRoot?.startsWith("/")) throw new Error("requires macOS and an explicit absolute new fixture root");
const root = resolve(rawRoot); if (existsSync(root)) throw new Error("new fixture root must not exist");
mkdirSync(root, { recursive: true, mode: 0o700 });
const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done()));
const instance = openInstance(join(root, "home", "app-support"));
const artifact = fileURLToPath(new URL("../../../sdk/src/workflows/execution-fixture.mjs", import.meta.url));
const manifest = join(root, "artifacts.json");
writeFileSync(manifest, JSON.stringify({ workflows: [{ path: artifact, type: "stuck-activity", version: "1" }], activities: [{ path: artifact, type: "loop", version: "1" }] }));
const name = "fixture.workflows", domain = `gui/${process.getuid!()}`;
const manager = new ServiceManagement(instance, [{
  name, domain, directory: root, plistDirectory: join(root, "plists"), logDirectory: join(root, "logs"), shutdownMs: 40000,
  command: nodeTsArgv(fileURLToPath(new URL("../../../bags/workflows/runtime/src/service.ts", import.meta.url))),
  environment: { PATH: process.env.PATH!, BARRY_HOME: join(root, "home"), BARRY_SECRET: "fixture-workflow-drain", BARRY_WORKFLOW_MODULE: manifest, BARRY_WORKFLOW_DRAIN_MS: String(drainBudget), PORT: String(port) },
}], launchd());
const headers = { Authorization: "Bearer fixture-workflow-drain", "Content-Type": "application/json" };
writeFileSync(join(root, "cleanup.json"), JSON.stringify({ root, instance, definitions: [manager.definition(name)] }), { mode: 0o600 });
const url = `http://127.0.0.1:${port}`;
const wait = async <T>(observe: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> => {
  const deadline = Date.now() + 20000;
  do { try { const value = await observe(); if (accepts(value)) return value; } catch { /* Readiness may be pending while launchd starts the fixture. */ } await delay(100); } while (Date.now() < deadline);
  throw new Error(`timed out: ${label}`);
};
const processTable = () => execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8" }).trim().split("\n").map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)!; return { pid: Number(match[1]), parent: Number(match[2]), started: match[3] };
});
const results: Record<string, unknown> = { instance: instance.id, domain, label: manager.label(name), root, configuredGracefulDrainMs: drainBudget, osShutdownBudgetMs: 40000 };
writeFileSync(join(root, "acceptance.json"), JSON.stringify(results), { mode: 0o600 });
try {
  await manager.apply(name, "add"); await manager.apply(name, "start");
  await wait(async () => (await fetch(url + "/health", { headers, signal: AbortSignal.timeout(500) })).ok, Boolean, "workflow readiness");
  const state = await manager.status(name); assert.ok(state.pid);
  const started = await fetch(url + "/api/runs", { method: "POST", headers, body: JSON.stringify({ id: "launchd-drain", type: "stuck-activity", version: "1", input: null }) }); assert.equal(started.status, 202);
  await wait(async () => (await (await fetch(url + "/api/runs/launchd-drain", { headers })).json()).commands[0]?.state, value => value === "leased", "noncooperative activity lease");
  await delay(200);
  const before = processTable(), owned = new Set([state.pid]);
  for (let changed = true; changed;) { changed = false; for (const row of before) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  assert.ok(owned.size > 1, "the scenario must own a real computation child");
  const captured = before.filter(row => owned.has(row.pid)), at = performance.now();
  await manager.apply(name, "stop");
  results.drainMs = performance.now() - at; assert.ok(Number(results.drainMs) < (mode === "full-budget" ? 40000 : 10000));
  const after = processTable(); assert.ok(captured.every(old => !after.some(row => row.pid === old.pid && row.started === old.started)), "every owned child exits before replacement");
  results.stoppedProcesses = captured;
  const errors = readFileSync(join(root, "logs", `${name}.err.log`), "utf8"); assert.doesNotMatch(errors, /closed database|not open|incomplete drain/);
  await manager.apply(name, "start");
  await wait(async () => (await fetch(url + "/health", { headers, signal: AbortSignal.timeout(500) })).ok, Boolean, "restart readiness");
  const restored = await fetch(url + "/api/runs/launchd-drain", { headers }); assert.equal(restored.status, 200);
  results.reopened = true; results.result = "passed";
  console.log("PASS real workflow launchd stop: noncooperative children exited; state reopened after restart");
} catch (error) { results.result = "failed"; results.problem = String(error); throw error; }
finally {
  await manager.apply(name, "remove"); results.cleaned = !(await manager.status(name)).loaded;
  writeFileSync(join(root, "acceptance.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
}
