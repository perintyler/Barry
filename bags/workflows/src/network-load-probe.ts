/** Disposable two-service HTTP workload. Children own independent state and executors. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WorkflowOwner, ActivityWorker, ProcessExecutor, inspectArtifact, connectOwnerV2, dispatchWorkerRequest } from "@barry-rocks/sdk/internal/workflows";
import { networkLatencyBudget, NETWORK_PROBE_BASELINE_SECONDS, NETWORK_PROBE_WARMUP_SECONDS, NETWORK_PROBE_HEARTBEAT_TIMEOUT_MS, NETWORK_PROBE_WORKLOAD, type LatencyWindow } from "./network-probe-budget.js";
import { probeChildrenExitedCleanly, stopProbeChild } from "./network-probe-cleanup.js";

const script = fileURLToPath(import.meta.url), mode = process.argv[2];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * .99)] : null;
const record = (values: number[], value: number) => { values.push(value); if (values.length > 20_000) values.shift(); };
interface Sample { timestamp: number; rss: number; heapUsed: number }
function slope(samples: Sample[], key: "rss" | "heapUsed"): number {
  if (samples.length < 2) return 0;
  const start = samples[0].timestamp, n = samples.length;
  let x = 0, y = 0, xy = 0, xx = 0;
  for (const sample of samples) { const t = (sample.timestamp - start) / 1000; x += t; y += sample[key]; xy += t * sample[key]; xx += t * t; }
  return n * xx === x * x ? 0 : (n * xy - x * y) / (n * xx - x * x) * 3600;
}
interface Metrics { reads: number[]; heartbeats: number[]; loops: number[]; heartbeatSamples: number; started: number; completed: number; failures: number; errorCounts: Record<string, number>; memory: Sample[]; databaseBytes: number[]; databaseGrowthBytes: number }
function metrics(): Metrics { return { reads: [], heartbeats: [], loops: [], heartbeatSamples: 0, started: 0, completed: 0, failures: 0, errorCounts: {}, memory: [], databaseBytes: [], databaseGrowthBytes: 0 }; }
const artifactSource = `export const definitions = [{type:'echo',version:'1',*run(input){return yield {kind:'activity',type:'echo@1',input:input.message,heartbeatTimeoutMs:${NETWORK_PROBE_HEARTBEAT_TIMEOUT_MS}};}}];`;
const activitySource = `export const activities={'echo@1':async input=>{await new Promise(resolve=>setTimeout(resolve,1200));return input;}};`;
async function child(role: "owner" | "worker") {
  const root = process.argv[3], data = metrics();
  const artifactPath = join(root, "artifact.mjs"), artifact = inspectArtifact(artifactPath, "echo", "1"), activityArtifact = inspectArtifact(join(root, "activity.mjs"), "echo@1", "1", false);
  const executor = new ProcessExecutor({ maxChildren: 4, wallMs: 15_000 });
  const owner = role === "owner" ? new WorkflowOwner({ id: "network-owner", path: join(root, "owner.db"), artifacts: [artifact], activityArtifacts: { "echo@1": activityArtifact.digest }, executor }) : undefined;
  const fail = (error: unknown) => { data.failures++; const key = error instanceof Error ? error.name : "UnknownError"; data.errorCounts[key] = (data.errorCounts[key] ?? 0) + 1; };
  const worker = role === "worker" ? new ActivityWorker({ capacity: 4, activities: { "echo@1": executor.activity(activityArtifact) }, artifacts: { "echo@1": activityArtifact.digest }, connections: [connectOwnerV2("network-owner", async request => {
    const begin = performance.now();
    const response = await fetch(`${process.argv[4]}/worker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`owner HTTP ${response.status}`);
    const result: unknown = await response.json();
    if ((request as { operation: string }).operation === "heartbeat") { record(data.heartbeats, performance.now() - begin); data.heartbeatSamples++; }
    return result;
  })], onError: fail }) : undefined;
  let stop = false, admit = true, lastSample = 0, initialBytes = 0;
  process.on("SIGTERM", () => { stop = true; }); process.on("SIGINT", () => { stop = true; });
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/metrics") { res.end(JSON.stringify(data)); return; }
      if (req.url === "/measure" && req.method === "POST") {
        // Keep cumulative run ids and outcomes, but never reuse calibration
        // timing or memory observations in the measured window.
        data.reads = []; data.heartbeats = []; data.loops = []; data.memory = [];
        data.heartbeatSamples = 0; lastSample = 0;
        res.end(JSON.stringify(data)); return;
      }
      if (req.url === "/drain") { admit = false; res.end("true"); return; }
      if (req.url === "/worker" && owner && req.method === "POST") {
        const parts: Buffer[] = []; let bytes = 0;
        for await (const part of req) { bytes += part.length; if (bytes > 1_048_576) throw new Error("oversized worker request"); parts.push(Buffer.from(part)); }
        res.end(JSON.stringify(dispatchWorkerRequest(owner, "network-worker", JSON.parse(Buffer.concat(parts).toString())))); return;
      }
      res.statusCode = 404; res.end("null");
    } catch (error) { fail(error); res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.send?.({ port: (server.address() as { port: number }).port });
  try {
    while (!stop) {
      const begin = performance.now();
      if (owner) {
        const read = performance.now(); owner.listPage({ limit: 50 }); const counts = owner.overview().counts; record(data.reads, performance.now() - read);
        data.completed = data.started - (counts.running ?? 0) - (counts.blocked ?? 0) - (counts.failed ?? 0) - (counts.timed_out ?? 0);
        if ((counts.failed ?? 0) || (counts.blocked ?? 0) || (counts.timed_out ?? 0)) throw new Error(`load run failed: ${JSON.stringify(counts)}`);
        if (admit) for (let open = counts.running ?? 0; open < 16; open++) owner.start({ id: `network-${data.started++}`, type: "echo", version: "1", input: { message: "x".repeat(1024) } });
        await owner.pump(); owner.prune(Date.now() - 30_000);
      }
      if (worker) await worker.tick();
      record(data.loops, performance.now() - begin);
      if (Date.now() - lastSample >= 5000) {
        data.memory.push({ timestamp: Date.now(), ...process.memoryUsage() });
        if (data.memory.length > 7000) data.memory.shift(); lastSample = Date.now();
        if (owner) { const bytes = ["", "-wal", "-shm"].reduce((sum, suffix) => { try { return sum + statSync(join(root, `owner.db${suffix}`)).size; } catch { return sum; } }, 0); initialBytes ||= bytes; data.databaseBytes = [bytes]; data.databaseGrowthBytes = bytes - initialBytes; }
      }
      await pause(10);
    }
  } finally {
    if (worker) await worker.drain(5000);
    await executor.close(); if (owner) { await owner.drain(); owner.close(); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    writeFileSync(join(root, `${role}-metrics.json`), JSON.stringify(data));
  }
}
if (mode === "--owner" || mode === "--worker") await child(mode === "--owner" ? "owner" : "worker");
else {
  const seconds = Number(mode ?? 60);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error("duration must be 1..86400 seconds");
  const output = process.argv[3];
  const root = output ? resolve(output) : mkdtempSync(join(tmpdir(), "workflow-network-load-"));
  if (output) mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "report.json"), JSON.stringify({ passed: false, receiptComplete: false, requestedDurationSeconds: seconds }));
  writeFileSync(join(root, "artifact.mjs"), artifactSource); writeFileSync(join(root, "activity.mjs"), activitySource);
  // Hash the executable probe and actual imported SDK bytes. Docs edits do not
  // affect this workload; rebuilding/changing runtime modules invalidates it.
  const sdkRuntime = dirname(dirname(fileURLToPath(import.meta.resolve("@barry-rocks/sdk/internal/workflows"))));
  const sourceDigest = () => {
    const hash = createHash("sha256").update(readFileSync(script)).update(readFileSync(new URL("./network-probe-budget.ts", import.meta.url))).update(readFileSync(new URL("./network-probe-cleanup.ts", import.meta.url)));
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:m?js|json)$/.test(entry.name)) hash.update(path.slice(sdkRuntime.length)).update(readFileSync(path));
      }
    };
    visit(sdkRuntime); return hash.digest("hex");
  };
  const sourceAtStart = sourceDigest(), children: ChildProcess[] = [];
  const start = (role: string, url = "") => new Promise<{ child: ChildProcess; url: string }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BARRY_") && !key.endsWith("API_KEY") && !key.endsWith("TOKEN")));
    const processChild = spawn(process.execPath, ["--import", "tsx", script, role, root, url], { env: { ...env, BARRY_HOME: join(root, role) }, stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(processChild);
    for (const stream of [processChild.stdout, processChild.stderr]) stream?.on("data", chunk => writeFileSync(join(root, `${role.slice(2)}.log`), chunk, { flag: "a" }));
    const timer = setTimeout(() => reject(new Error(`${role} startup timed out; ${root}`)), 30000);
    processChild.once("message", message => { clearTimeout(timer); resolve({ child: processChild, url: `http://127.0.0.1:${(message as { port: number }).port}` }); });
    processChild.once("exit", code => { clearTimeout(timer); reject(new Error(`${role} exited ${code}; ${root}`)); });
    processChild.once("error", reject);
  });
  let interrupted = false; const interrupt = () => { interrupted = true; }; process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let workloadPassed = false, measurementComplete = false;
  try {
    const owner = await start("--owner"), worker = await start("--worker", owner.url);
    const workloadBegin = performance.now();
    const get = async (url: string) => { const response = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5000) }); assert.ok(response.ok); return await response.json() as Metrics; };
    const waitWindow = async (duration: number) => {
      const begin = performance.now();
      while (!interrupted && performance.now() - begin < duration * 1000) { assert.ok(children.every(child => child.exitCode === null), `child exited; ${root}`); await pause(Math.min(1000, duration * 1000)); }
      assert.ok(!interrupted, "probe interrupted");
      return (performance.now() - begin) / 1000;
    };
    const resetWindow = async () => {
      const boundaries: Metrics[] = [];
      for (const service of [owner, worker]) { const response = await fetch(`${service.url}/measure`, { method: "POST", signal: AbortSignal.timeout(5000) }); assert.ok(response.ok, "window reset failed"); boundaries.push(await response.json() as Metrics); }
      return boundaries;
    };
    const timingWindow = (a: Metrics, b: Metrics, durationSeconds: number): LatencyWindow => ({ durationSeconds, readP99Ms: percentile(a.reads), heartbeatP99Ms: percentile(b.heartbeats), readSamples: a.reads.length, heartbeatSamples: b.heartbeats.length, sourceDigest: sourceDigest() });
    const warmupSeconds = await waitWindow(NETWORK_PROBE_WARMUP_SECONDS);
    await resetWindow();
    const baselineDurationSeconds = await waitWindow(NETWORK_PROBE_BASELINE_SECONDS);
    const baselineOwner = await get(owner.url), baselineWorker = await get(worker.url);
    const baseline = timingWindow(baselineOwner, baselineWorker, baselineDurationSeconds);
    writeFileSync(join(root, "baseline-owner-metrics.json"), JSON.stringify(baselineOwner));
    writeFileSync(join(root, "baseline-worker-metrics.json"), JSON.stringify(baselineWorker));
    writeFileSync(join(root, "baseline.json"), JSON.stringify({ schemaVersion: 1, warmupSeconds, window: baseline, workload: NETWORK_PROBE_WORKLOAD }, null, 2));
    assert.equal(baselineOwner.failures + baselineWorker.failures, 0, "calibration workload had errors");
    // Validate calibration before spending an hour or overnight measuring. A
    // missing/slow baseline fails clearly instead of silently growing a budget.
    networkLatencyBudget(baseline, { ...baseline, durationSeconds: seconds }, seconds, NETWORK_PROBE_HEARTBEAT_TIMEOUT_MS);
    const [measurementStart] = await resetWindow();
    const durationSeconds = await waitWindow(seconds);
    const measuredOwner = await get(owner.url), measuredWorker = await get(worker.url);
    const measurement = timingWindow(measuredOwner, measuredWorker, durationSeconds);
    const latencyBudget = networkLatencyBudget(baseline, measurement, seconds, NETWORK_PROBE_HEARTBEAT_TIMEOUT_MS);
    await fetch(`${owner.url}/drain`);
    const drainDeadline = Date.now() + 60000;
    while (Date.now() < drainDeadline) { const current = await get(owner.url); if (current.started === current.completed) break; await pause(100); }
    const a = await get(owner.url), b = await get(worker.url), memory = [...measuredOwner.memory, ...measuredWorker.memory];
    const samples = (metrics: Metrics) => seconds > 60 ? metrics.memory.filter(sample => sample.timestamp >= metrics.memory[0].timestamp + 60000) : metrics.memory;
    const sqlite = new DatabaseSync(":memory:"), sqliteVersion = sqlite.prepare("SELECT sqlite_version() version").get()?.version; sqlite.close();
    const report = {
      schemaVersion: 2, passed: false, receiptComplete: false, durationSeconds, requestedDurationSeconds: seconds, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"), node: process.version, sqlite: sqliteVersion, os: `${process.platform} ${release()}`, hardware: cpus()[0].model, totalMemoryBytes: totalmem(),
      workload: NETWORK_PROBE_WORKLOAD,
      latencyCalibration: { ...latencyBudget, warmupSeconds, baseline, measurement },
      workloadDurationSeconds: (performance.now() - workloadBegin) / 1000,
      counterWindow: "warmup+baseline+measurement+drain",
      measurementWork: { durationSeconds, started: measuredOwner.started - measurementStart.started, completed: measuredOwner.completed - measurementStart.completed, inflightAtStart: measurementStart.started - measurementStart.completed, inflightAtEnd: measuredOwner.started - measuredOwner.completed },
      started: a.started, completed: a.completed, failures: a.failures + b.failures, heartbeatSamples: b.heartbeatSamples, peakSupervisorRssBytes: Math.max(...a.memory.map(sample => sample.rss)) + Math.max(...b.memory.map(sample => sample.rss)),
      memoryStability: { heapSlopeBytesPerHour: slope(samples(measuredOwner), "heapUsed") + slope(samples(measuredWorker), "heapUsed"), rssSlopeBytesPerHour: slope(samples(measuredOwner), "rss") + slope(samples(measuredWorker), "rss"), maxHeapBytesPerHourAllowed: 10 * 1024 ** 2, maxRssBytesPerHourAllowed: 10 * 1024 ** 2, samples: memory.length },
      databaseBytes: a.databaseBytes, databaseGrowthBytes: a.databaseGrowthBytes, readP99Ms: measurement.readP99Ms, heartbeatP99Ms: measurement.heartbeatP99Ms, schedulerTurnP99Ms: percentile([...measuredOwner.loops, ...measuredWorker.loops]), errorCounts: { owner: a.errorCounts, worker: b.errorCounts }, sourceAtStart, sourceAtEnd: sourceDigest(), retentionSeconds: 30, receiptDirectory: root,
    };
    measurementComplete = true;
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
    assert.ok(!interrupted && durationSeconds >= seconds, "probe was interrupted or shorter than requested");
    assert.equal(report.sourceAtStart, report.sourceAtEnd, "source changed during probe");
    assert.equal(report.failures, 0); assert.ok(a.completed > 0); assert.equal(a.completed, a.started, "work did not drain"); assert.ok(b.heartbeatSamples > 0, "no heartbeat observations");
    assert.ok(report.measurementWork.completed > 0 && report.measurementWork.started > 0, "requested measurement window performed no complete workload");
    assert.ok(latencyBudget.passed, `p99 regression: read ${measurement.readP99Ms}ms / ${latencyBudget.readBudgetMs}ms budget; heartbeat ${measurement.heartbeatP99Ms}ms / ${latencyBudget.heartbeatBudgetMs}ms budget`);
    if (seconds > 60) { assert.ok(samples(measuredOwner).length >= 5 && samples(measuredWorker).length >= 5, "insufficient post-warmup memory samples"); assert.ok(report.memoryStability.heapSlopeBytesPerHour <= 10 * 1024 ** 2 && report.memoryStability.rssSlopeBytesPerHour <= 10 * 1024 ** 2, "memory growth exceeds 10 MiB/hour across services"); }
    workloadPassed = true;
  } catch (error) {
    const reportPath = join(root, "report.json");
    const existing = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    writeFileSync(reportPath, JSON.stringify({ ...existing, passed: false, failure: error instanceof Error ? error.message : String(error) }, null, 2));
    throw error;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    const exits = await Promise.all(children.map((child, index) => stopProbeChild(child, index === 0 ? "owner" : "worker")));
    const cleanupPassed = probeChildrenExitedCleanly(exits);
    let sourceAtEnd: string | null = null, sourceFailure: string | undefined;
    try { sourceAtEnd = sourceDigest(); }
    catch (error) { sourceFailure = `final source verification failed: ${error instanceof Error ? error.message : String(error)}`; }
    const sourceStable = sourceAtEnd === sourceAtStart;
    const reportPath = join(root, "report.json");
    const existing = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    const failure = [existing.failure, !cleanupPassed ? "probe children did not exit cleanly" : undefined, !sourceStable ? sourceFailure ?? "source changed during probe cleanup" : undefined].filter(Boolean).join("; ");
    const report = { ...existing, sourceAtStart, sourceAtEnd, passed: workloadPassed && cleanupPassed && sourceStable, receiptComplete: measurementComplete && cleanupPassed && sourceStable, cleanup: { passed: cleanupPassed, children: exits }, ...(failure ? { failure } : {}) };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (report.passed) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!cleanupPassed || !sourceStable) { process.exitCode = 1; process.stderr.write(`${String(report.failure ?? "probe cleanup failed")}\n`); }
  }
}
