import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("soak trend rejects timing regressions and incomplete receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-soak-trend-")), history = join(root, "history"), candidate = join(root, "candidate.json");
  mkdirSync(history);
  const report = { passed: true, receiptComplete: true, durationSeconds: 3600, requestedDurationSeconds: 3600, failures: 0, sourceAtStart: "a", sourceAtEnd: "a", workload: { owners: 1, workers: 1, slotsPerWorker: 4, openRunsPerOwner: 16, inputBytes: 1024, transport: "HTTP loopback" }, os: "test", node: "26", hardware: "test", readP99Ms: 10, heartbeatP99Ms: 10, schedulerTurnP99Ms: 10, memoryStability: { rssSlopeBytesPerHour: 0, heapSlopeBytesPerHour: 0 } };
  const write = value => writeFileSync(candidate, JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [new URL("./soak-trend.mjs", import.meta.url).pathname, candidate, history], { encoding: "utf8" });
  try {
    for (let index = 0; index < 5; index++) writeFileSync(join(history, `${index}.json`), JSON.stringify(report));
    write(report); assert.equal(run().status, 0);
    write({ ...report, readP99Ms: 30 }); const regression = run(); assert.equal(regression.status, 1); assert.match(regression.stderr, /readP99Ms/);
    write({ ...report, durationSeconds: 3599 }); assert.equal(run().status, 1);
    write({ ...report, passed: false }); assert.equal(run().status, 1);
    write({ ...report, receiptComplete: false }); assert.equal(run().status, 1);
    write({ ...report, sourceAtEnd: "changed" }); assert.equal(run().status, 1);
    write({ ...report, readP99Ms: null }); assert.equal(run().status, 1);
    // A missing metric in a matching historical receipt previously produced a
    // NaN threshold and falsely passed arbitrarily large finite regressions.
    const damaged = { ...report }; delete damaged.readP99Ms;
    writeFileSync(join(history, "4.json"), JSON.stringify(damaged));
    write({ ...report, readP99Ms: 1e9 });
    const malformed = run(); assert.equal(malformed.status, 1); assert.match(malformed.stderr, /history 4.json: invalid metric readP99Ms/);
    writeFileSync(join(history, "4.json"), JSON.stringify({ ...report, sourceAtEnd: "changed" }));
    assert.match(run().stderr, /history 4.json: receipt source/);
    writeFileSync(join(history, "4.json"), JSON.stringify(report));
    // Capacity, run count and payload changes are different workloads; unrelated
    // receipts must not impose a threshold on the new workload.
    for (const dimension of ["owners", "workers", "slotsPerWorker", "openRunsPerOwner", "inputBytes"]) {
      write({ ...report, workload: { ...report.workload, [dimension]: report.workload[dimension] * 2 }, readP99Ms: 1e9 });
      const different = run(); assert.equal(different.status, 0); assert.match(different.stdout, /no comparable baseline/);
    }
    // Workload property ordering must not prevent comparison.
    write({ ...report, workload: Object.fromEntries(Object.entries(report.workload).reverse()), readP99Ms: 1e9 });
    assert.equal(run().status, 1);
    // Additional dimensions are included, so future workload changes do not
    // silently inherit older incomparable baselines.
    write({ ...report, workload: { ...report.workload, payloadShape: "new" }, readP99Ms: 1e9 });
    assert.match(run().stdout, /no comparable baseline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relative receipts validate independent windows and retain baseline regression detection", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-relative-soak-")), history = join(root, "history"), candidate = join(root, "candidate.json");
  mkdirSync(history);
  const window = { durationSeconds: 30, readP99Ms: 10, heartbeatP99Ms: 100, readSamples: 400, heartbeatSamples: 150, sourceDigest: "a".repeat(64) };
  const report = { schemaVersion: 2, passed: true, receiptComplete: true, durationSeconds: 60, requestedDurationSeconds: 60, failures: 0, sourceAtStart: window.sourceDigest, sourceAtEnd: window.sourceDigest, workload: { owners: 1, workers: 1, slotsPerWorker: 4, openRunsPerOwner: 16, inputBytes: 1024, transport: "HTTP loopback" }, os: "test", node: "26", hardware: "test", readP99Ms: 10, heartbeatP99Ms: 100, schedulerTurnP99Ms: 10, memoryStability: { rssSlopeBytesPerHour: 0, heapSlopeBytesPerHour: 0 }, latencyCalibration: { schemaVersion: 1, method: "separate initial window; identical controlled workload", multiplier: 1.25, noiseAllowanceMs: 5, minimumSamples: 100, heartbeatTimeoutMs: 2000, deadlineSafetyFraction: 0.5, deadlineBudgetMs: 1000, readBudgetMs: 17.5, heartbeatBudgetMs: 130, passed: true, warmupSeconds: 10, baseline: window, measurement: { ...window, durationSeconds: 60 } } };
  Object.assign(report, { workloadDurationSeconds: 110, counterWindow: "warmup+baseline+measurement+drain", started: 200, completed: 200, measurementWork: { durationSeconds: 60, started: 100, completed: 100, inflightAtStart: 16, inflightAtEnd: 16 }, cleanup: { passed: true, children: ["owner", "worker"].map((role, index) => ({ role, pid: index + 100, exited: true, exitCode: 0, signalCode: null, forcedKill: false })) } });
  const write = value => writeFileSync(candidate, JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [new URL("./soak-trend.mjs", import.meta.url).pathname, candidate, history], { encoding: "utf8" });
  try {
    writeFileSync(join(history, "1.json"), JSON.stringify(report)); write(report); assert.equal(run().status, 0);
    for (const patch of [{ cleanup: { ...report.cleanup, passed: false } }, { cleanup: { ...report.cleanup, children: report.cleanup.children.map(exit => ({ ...exit, pid: 100 })) } }, { cleanup: { ...report.cleanup, children: report.cleanup.children.map(exit => ({ ...exit, exitCode: 1 })) } }, { cleanup: { ...report.cleanup, children: report.cleanup.children.map(exit => ({ ...exit, signalCode: "SIGKILL", exitCode: null })) } }, { workloadDurationSeconds: 60 }, { measurementWork: { ...report.measurementWork, started: 0, completed: 0 } }]) {
      write({ ...report, ...patch }); assert.equal(run().status, 1);
    }
    for (const patch of [{ heartbeatTimeoutMs: 200_000, deadlineBudgetMs: 100_000 }, { minimumSamples: 1 }, { multiplier: 10 }, { readBudgetMs: 1000 }, { warmupSeconds: 9 }, { passed: false }, { baseline: { ...window, heartbeatSamples: 99 } }, { baseline: { ...window, sourceDigest: "b".repeat(64) } }]) {
      write({ ...report, latencyCalibration: { ...report.latencyCalibration, ...patch } }); assert.equal(run().status, 1);
    }
    // Initial baseline degradation is not hidden by a generous relative budget,
    // even if the eventual measurement returns to its historical latency.
    write({ ...report, latencyCalibration: { ...report.latencyCalibration, heartbeatBudgetMs: 255, baseline: { ...window, heartbeatP99Ms: 200 } } });
    const degraded = run(); assert.equal(degraded.status, 1); assert.match(degraded.stderr, /baselineHeartbeatP99Ms/);
    // Older absolute-limit receipts cannot become calibration history.
    const legacy = { ...report }; delete legacy.schemaVersion; delete legacy.latencyCalibration;
    writeFileSync(join(history, "1.json"), JSON.stringify(legacy)); write(report);
    assert.match(run().stdout, /no comparable baseline/);
    // A malformed receipt using the same policy fails instead of disappearing.
    writeFileSync(join(history, "1.json"), JSON.stringify({ ...report, latencyCalibration: { ...report.latencyCalibration, baseline: { ...window, readSamples: 0 } } }));
    assert.match(run().stderr, /history 1.json: invalid baseline read samples/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
