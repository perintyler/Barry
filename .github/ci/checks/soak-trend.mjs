/** Compare a network probe receipt with up to five matching retained baselines. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [candidatePath, historyDirectory] = process.argv.slice(2);
if (!candidatePath || !historyDirectory) throw new Error("usage: soak-trend.mjs <candidate-report.json> <history-directory>");
const metrics = [
  ["readP99Ms", report => report.readP99Ms, 5],
  ["heartbeatP99Ms", report => report.heartbeatP99Ms, 5],
  ["schedulerTurnP99Ms", report => report.schedulerTurnP99Ms, 5],
  ["rssSlopeBytesPerHour", report => report.memoryStability?.rssSlopeBytesPerHour, 1024 ** 2],
  ["heapSlopeBytesPerHour", report => report.memoryStability?.heapSlopeBytesPerHour, 1024 ** 2],
];
function calibrationPolicy(report) {
  const calibration = report.latencyCalibration;
  return JSON.stringify([report.schemaVersion ?? 1, calibration?.schemaVersion, calibration?.method, calibration?.multiplier, calibration?.noiseAllowanceMs, calibration?.minimumSamples, calibration?.heartbeatTimeoutMs, calibration?.deadlineSafetyFraction]);
}
function validateReceipt(report, label) {
  const refuse = reason => { throw new Error(`${label}: ${reason}`); };
  if (!report || report.passed !== true || report.receiptComplete !== true || report.failures !== 0) refuse("receipt is incomplete or has failures");
  if (typeof report.sourceAtStart !== "string" || !report.sourceAtStart || report.sourceAtStart !== report.sourceAtEnd) refuse("receipt source is missing or changed during the probe");
  if (!Number.isFinite(report.durationSeconds) || !Number.isInteger(report.requestedDurationSeconds) || report.requestedDurationSeconds <= 0 || report.durationSeconds < report.requestedDurationSeconds) refuse("receipt duration is invalid or shorter than requested");
  for (const key of ["node", "os", "hardware"]) if (typeof report[key] !== "string" || !report[key]) refuse(`missing ${key}`);
  if (typeof report.workload?.transport !== "string" || !report.workload.transport) refuse("missing workload transport");
  for (const key of ["owners", "workers", "slotsPerWorker", "openRunsPerOwner", "inputBytes"]) if (!Number.isInteger(report.workload[key]) || report.workload[key] <= 0) refuse(`invalid workload ${key}`);
  for (const [name, value] of metrics) if (!Number.isFinite(value(report)) || (name.endsWith("P99Ms") && value(report) < 0)) refuse(`invalid metric ${name}`);
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1 && report.schemaVersion !== 2) refuse("unsupported receipt schema version");
  if ((report.schemaVersion ?? 1) === 1) { if (report.latencyCalibration !== undefined) refuse("legacy receipt cannot carry relative calibration"); return; }
  const exits = report.cleanup?.children;
  if (report.cleanup?.passed !== true || !Array.isArray(exits) || exits.length !== 2 || new Set(exits.map(exit => exit.role)).size !== 2 || new Set(exits.map(exit => exit.pid)).size !== 2 || !exits.some(exit => exit.role === "owner") || !exits.some(exit => exit.role === "worker") || exits.some(exit => !Number.isInteger(exit.pid) || exit.pid <= 0 || exit.exited !== true || exit.exitCode !== 0 || exit.signalCode !== null || exit.forcedKill !== false)) refuse("probe cleanup did not finish cleanly");
  if (report.counterWindow !== "warmup+baseline+measurement+drain" || !Number.isFinite(report.workloadDurationSeconds) || report.workloadDurationSeconds < report.durationSeconds + 40 || !Number.isInteger(report.started) || report.started <= 0 || report.completed !== report.started) refuse("invalid cumulative workload accounting");
  const work = report.measurementWork;
  if (!work || work.durationSeconds !== report.durationSeconds || !Number.isInteger(work.started) || work.started <= 0 || !Number.isInteger(work.completed) || work.completed <= 0 || !Number.isInteger(work.inflightAtStart) || work.inflightAtStart < 0 || !Number.isInteger(work.inflightAtEnd) || work.inflightAtEnd < 0 || work.started - work.completed !== work.inflightAtEnd - work.inflightAtStart || work.started > report.started || work.completed > report.completed) refuse("requested measurement performed no valid complete workload");
  const calibration = report.latencyCalibration;
  if (!calibration || calibration.schemaVersion !== 1 || calibration.method !== "separate initial window; identical controlled workload" || calibration.multiplier !== 1.25 || calibration.noiseAllowanceMs !== 5 || calibration.minimumSamples !== 100 || calibration.deadlineSafetyFraction !== 0.5 || calibration.passed !== true) refuse("invalid calibration policy");
  if (!Number.isFinite(calibration.warmupSeconds) || calibration.warmupSeconds < 10 || calibration.heartbeatTimeoutMs !== 2000) refuse("invalid warmup or fixture heartbeat deadline");
  const safety = calibration.heartbeatTimeoutMs * calibration.deadlineSafetyFraction;
  if (calibration.deadlineBudgetMs !== safety) refuse("incorrect deadline budget");
  for (const [name, window, minimum] of [["baseline", calibration.baseline, 30], ["measurement", calibration.measurement, report.requestedDurationSeconds]]) {
    if (!window || !Number.isFinite(window.durationSeconds) || window.durationSeconds < minimum || !/^[a-f0-9]{64}$/.test(window.sourceDigest) || window.sourceDigest !== report.sourceAtStart) refuse(`invalid ${name} window or source`);
    for (const metric of ["read", "heartbeat"]) {
      if (!Number.isInteger(window[`${metric}Samples`]) || window[`${metric}Samples`] < calibration.minimumSamples || !Number.isFinite(window[`${metric}P99Ms`]) || window[`${metric}P99Ms`] < 0) refuse(`invalid ${name} ${metric} samples`);
    }
  }
  for (const metric of ["read", "heartbeat"]) {
    const baseline = calibration.baseline[`${metric}P99Ms`], observed = calibration.measurement[`${metric}P99Ms`];
    const budget = Math.min(baseline * calibration.multiplier + calibration.noiseAllowanceMs, safety);
    if (baseline >= safety || calibration[`${metric}BudgetMs`] !== budget || observed > budget || report[`${metric}P99Ms`] !== observed) refuse(`invalid or failed ${metric} calibration budget`);
  }
  if (calibration.measurement.durationSeconds !== report.durationSeconds) refuse("measurement duration differs from receipt");
}
// Include every workload dimension, including future additions, independent of key order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const workloadKey = report => JSON.stringify(canonical(report.workload));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
validateReceipt(candidate, "candidate");
const history = readdirSync(historyDirectory).filter(name => name.endsWith(".json")).map(name => ({ name, report: JSON.parse(readFileSync(join(historyDirectory, name), "utf8")) })).filter(({ name, report }) => {
  if (report.workload?.transport !== candidate.workload.transport || report.node !== candidate.node || report.os !== candidate.os || report.hardware !== candidate.hardware || report.requestedDurationSeconds !== candidate.requestedDurationSeconds) return false;
  // Different receipt/calibration policies are never interchangeable baselines.
  if (calibrationPolicy(report) !== calibrationPolicy(candidate)) return false;
  // A damaged matching receipt must fail closed rather than turn a median/limit into NaN.
  validateReceipt(report, `history ${name}`);
  return workloadKey(report) === workloadKey(candidate);
}).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(-5);
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
if (history.length === 0) console.log("Soak trend: no comparable baseline; retain this receipt to establish history.");
else {
  const failures = [];
  const comparisonMetrics = candidate.schemaVersion === 2 ? [...metrics,
    ["baselineReadP99Ms", report => report.latencyCalibration.baseline.readP99Ms, 5],
    ["baselineHeartbeatP99Ms", report => report.latencyCalibration.baseline.heartbeatP99Ms, 5],
  ] : metrics;
  for (const [name, value, tolerance] of comparisonMetrics) {
    const baseline = median(history.map(({ report }) => value(report)));
    const limit = Math.max(0, baseline) * 1.25 + tolerance;
    if (value(candidate) > limit) failures.push(`${name}: ${value(candidate)} > ${limit} (median ${baseline})`);
  }
  if (failures.length) { console.error(`Soak trend regression against ${history.length} receipt(s):\n${failures.join("\n")}`); process.exitCode = 1; }
  else console.log(`Soak trend passed against ${history.length} comparable receipts: 25% relative tolerance plus 5ms timing / 1 MiB per hour slope noise allowance.`);
}
