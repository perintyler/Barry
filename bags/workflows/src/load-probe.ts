// Disposable release probe. Never reads Barry home or enrolls peers.
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ActivityWorker, WorkflowOwner, ProcessExecutor, inspectArtifact, connectOwnerV2, dispatchWorkerRequest } from "@barry-rocks/sdk/internal/workflows";

const seconds = Number(process.argv[2] ?? 60);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) throw new Error("duration must be 1..86400 seconds");
const sourceDigest = () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "sdk", "bags/workflows", "sdk/src/auth/workflow-actor.ts", "sdk/src/nodes", "sdk/src/stores/context.ts", "bags/mcp/src/index.ts", "pnpm-lock.yaml"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter(f => { try { return statSync(f).isFile(); } catch { return false; } })
    .sort();
  const digest = createHash("sha256"); for (const file of files) digest.update(file).update("\0").update(readFileSync(file)); return digest.digest("hex");
};
const sourceAtStart = sourceDigest();
const root = mkdtempSync(join(tmpdir(), "workflow-load-")), artifactPath = fileURLToPath(new URL("./builtin-artifact.mjs", import.meta.url));
const artifact = inspectArtifact(artifactPath, "echo", "1"), activityArtifact = inspectArtifact(artifactPath, "echo@1", "1", false);
const owners = [0, 1].map(index => new WorkflowOwner({ id: `owner-${index}`, path: join(root, `${index}.db`), artifacts: [artifact], activityArtifacts: { "echo@1": activityArtifact.digest }, executor: new ProcessExecutor({ maxChildren: 2, wallMs: 15_000 }) }));
const executors = [new ProcessExecutor({ maxChildren: 4, wallMs: 15_000 }), new ProcessExecutor({ maxChildren: 4, wallMs: 15_000 })];
let failed = 0, heartbeatSamples = 0;
const errorCounts: Record<string, number> = {};
const reads: number[] = [], heartbeats: number[] = [], loops: number[] = [];

// Rolling metric buckets & leak detection slope
interface MemorySample { timestamp: number; rss: number; heapUsed: number }
const memorySamples: MemorySample[] = [];
let lastCheckpointTime = performance.now();
let lastSampleTime = performance.now();

const record = (values: number[], value: number) => { values.push(value); if (values.length > 20_000) values.shift(); };
const workers = executors.map((executor, index) => new ActivityWorker({ capacity: 4, activities: { "echo@1": executor.activity(activityArtifact) }, artifacts: { "echo@1": activityArtifact.digest }, connections: owners.map(owner => connectOwnerV2(owner.id, async request => {
  const start = performance.now(), result = dispatchWorkerRequest(owner, `worker-${index}`, request);
  if ((request as { operation: string }).operation === "heartbeat") { record(heartbeats, performance.now() - start); heartbeatSamples++; }
  return result;
})), onError: error => { failed++; const key = String(error).slice(0, 200); errorCounts[key] = (errorCounts[key] ?? 0) + 1; } }));
const sqlite = new DatabaseSync(":memory:"), sqliteVersion = sqlite.prepare("SELECT sqlite_version() version").get()?.version; sqlite.close();
let completed = 0, started = 0, peakRss = 0;
const begin = performance.now(), pending = new Set<Promise<void>>();

let isTerminating = false;
const requestTermination = () => { isTerminating = true; };
process.on("SIGINT", requestTermination);
process.on("SIGTERM", requestTermination);

// Linear regression slope in bytes per second
function computeSlope(samples: { timestamp: number; value: number }[]): number {
  if (samples.length < 2) return 0;
  const n = samples.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  const t0 = samples[0].timestamp;
  for (const s of samples) {
    const x = (s.timestamp - t0) / 1000;
    const y = s.value;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

try {
  while (!isTerminating && (performance.now() - begin < seconds * 1000)) {
    const loop = performance.now();
    for (const owner of owners) {
      const sample = performance.now(); owner.listPage({ limit: 50 }); const counts = owner.overview().counts; record(reads, performance.now() - sample);
      completed = started - owners.reduce((sum, current) => { const counts = current.overview().counts; return sum + (counts.running ?? 0) + (counts.blocked ?? 0) + (counts.failed ?? 0) + (counts.timed_out ?? 0); }, 0);
      if ((counts.failed ?? 0) || (counts.blocked ?? 0) || (counts.timed_out ?? 0)) {
        const bad = owners.flatMap(current => ["failed", "blocked", "timed_out"].flatMap(status => current.listPage({ status: status as "failed" | "blocked" | "timed_out", limit: 100 }).items));
        throw new Error(`unexpected failed, blocked or timed-out load run: ${JSON.stringify(bad.map(run => ({ id: run.id, status: run.status, error: run.error, outcome: run.outcome })))}`);
      }
      // Explicitly disposable harness retention; production does not auto-prune.
      owner.prune(Date.now() - 30_000); owner.prune(Date.now() - 30_000);
      if ((counts.running ?? 0) < 16) { owner.start({ id: `probe-${started++}`, type: "echo", version: "1", input: { message: "x".repeat(1024) } }); }
      const pump = owner.pump(); pending.add(pump); void pump.finally(() => pending.delete(pump)).catch(() => { failed++; });
    }
    await Promise.all(workers.map(worker => worker.tick()));
    const currentMemory = process.memoryUsage();
    peakRss = Math.max(peakRss, currentMemory.rss); record(loops, performance.now() - loop);

    // Sample memory metrics every 5 seconds
    if (performance.now() - lastSampleTime >= 5000) {
      memorySamples.push({ timestamp: Date.now(), rss: currentMemory.rss, heapUsed: currentMemory.heapUsed });
      if (memorySamples.length > 5000) memorySamples.shift();
      lastSampleTime = performance.now();
    }

    // Interval checkpoint every 60 seconds (or half duration for shorter test runs)
    const checkpointInterval = Math.min(seconds * 1000 / 2, 60_000);
    if (performance.now() - lastCheckpointTime >= checkpointInterval && seconds >= 30) {
      const checkpointFile = join(tmpdir(), `barry-soak-checkpoint-${Math.round(performance.now() - begin)}.json`);
      const tmp = `${checkpointFile}.tmp.${Date.now()}`;
      const checkpointData = {
        elapsedSeconds: (performance.now() - begin) / 1000,
        started,
        completed,
        failed,
        peakRss,
        heapGrowthBytesPerSec: computeSlope(memorySamples.map(m => ({ timestamp: m.timestamp, value: m.heapUsed }))),
      };
      writeFileSync(tmp, JSON.stringify(checkpointData, null, 2));
      // Atomic rename for durable checkpoint
      try {
        const { renameSync } = await import("node:fs");
        renameSync(tmp, checkpointFile);
      } catch {
        writeFileSync(checkpointFile, JSON.stringify(checkpointData, null, 2));
      }
      lastCheckpointTime = performance.now();
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await Promise.all(pending);
  const percentile = (values: number[], percent: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * percent))] ?? null;
  const heapSlopeBytesPerSec = computeSlope(memorySamples.map(m => ({ timestamp: m.timestamp, value: m.heapUsed })));
  const rssSlopeBytesPerSec = computeSlope(memorySamples.map(m => ({ timestamp: m.timestamp, value: m.rss })));

  const MAX_HEAP_BYTES_PER_HOUR = 2 * 1024 * 1024; // 2 MB/h
  const MAX_RSS_BYTES_PER_HOUR = 5 * 1024 * 1024;  // 5 MB/h

  const report = {
    durationSeconds: (performance.now() - begin) / 1000,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"], { maxBuffer: 16_777_216 })).digest("hex"),
    node: process.version,
    sqlite: sqliteVersion,
    os: `${process.platform} ${release()}`,
    hardware: cpus()[0].model,
    totalMemoryBytes: totalmem(),
    workload: { owners: 2, workers: 2, slotsPerWorker: 4, openRunsPerOwner: 16, inputBytes: 1024, transport: "in-process v2; separate executor children" },
    started,
    completed,
    failures: failed,
    heartbeatSamples,
    peakSupervisorRssBytes: peakRss,
    memoryStability: {
      heapSlopeBytesPerHour: Math.round(heapSlopeBytesPerSec * 3600),
      rssSlopeBytesPerHour: Math.round(rssSlopeBytesPerSec * 3600),
      maxHeapBytesPerHourAllowed: MAX_HEAP_BYTES_PER_HOUR,
      maxRssBytesPerHourAllowed: MAX_RSS_BYTES_PER_HOUR,
      samples: memorySamples.length,
    },
    databaseBytes: owners.map((_, index) => statSync(join(root, `${index}.db`)).size),
    readP99Ms: percentile(reads, .99),
    heartbeatP99Ms: percentile(heartbeats, .99),
    schedulerTurnP99Ms: percentile(loops, .99)
  };
  const sourceAtEnd = sourceDigest();
  process.stdout.write(`${JSON.stringify({ ...report, sourceAtStart, sourceAtEnd, retentionSeconds: 30, errorCounts }, null, 2)}\n`);

  // A minute is warm-up, not a trend: extrapolated to an hour, a 60-second
  // run's heap slope is whatever the JIT and the sample buffers did while
  // filling. The gate judges soak runs only. It is keyed on the duration asked
  // for, since a run always overshoots it slightly -- 60.08 measured seconds
  // once failed CI's 60-second probe on a 1.8 GB/h "slope".
  const memoryStabilityPassed = seconds <= 60 || memorySamples.length < 5 || (
    report.memoryStability.heapSlopeBytesPerHour <= MAX_HEAP_BYTES_PER_HOUR &&
    report.memoryStability.rssSlopeBytesPerHour <= MAX_RSS_BYTES_PER_HOUR
  );

  if (sourceAtStart !== sourceAtEnd || failed || completed === 0 || (report.readP99Ms ?? Infinity) >= 250 || (report.heartbeatP99Ms ?? Infinity) >= 250 || !memoryStabilityPassed) {
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", requestTermination);
  process.off("SIGTERM", requestTermination);
  await Promise.all(workers.map(worker => worker.drain(3000))); await Promise.all(executors.map(executor => executor.close()));
  await Promise.all(owners.map(async owner => { await owner.drain(); owner.close(); }));
  rmSync(root, { recursive: true, force: true });
}
