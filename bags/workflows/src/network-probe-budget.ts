import assert from "node:assert/strict";

export const NETWORK_PROBE_WARMUP_SECONDS = 10;
export const NETWORK_PROBE_BASELINE_SECONDS = 30;
export const NETWORK_PROBE_MIN_SAMPLES = 100;
export const NETWORK_PROBE_HEARTBEAT_TIMEOUT_MS = 2000;
export const NETWORK_PROBE_WORKLOAD = { owners: 1, workers: 1, slotsPerWorker: 4, openRunsPerOwner: 16, inputBytes: 1024, transport: "HTTP loopback; separate owner and worker service processes" };

export interface LatencyWindow {
  durationSeconds: number;
  readP99Ms: number | null;
  heartbeatP99Ms: number | null;
  readSamples: number;
  heartbeatSamples: number;
  sourceDigest: string;
}

/** An independent initial window sets the budget; measurements never enlarge it. */
export function networkLatencyBudget(baseline: LatencyWindow, measurement: LatencyWindow, requestedSeconds: number, heartbeatTimeoutMs: number) {
  assert.ok(Number.isInteger(requestedSeconds) && requestedSeconds > 0, "requested duration is invalid");
  assert.ok(Number.isFinite(heartbeatTimeoutMs) && heartbeatTimeoutMs > 0, "heartbeat deadline is invalid");
  for (const [name, window, minimumDuration] of [["baseline", baseline, NETWORK_PROBE_BASELINE_SECONDS], ["measurement", measurement, requestedSeconds]] as const) {
    assert.ok(Number.isFinite(window.durationSeconds) && window.durationSeconds >= minimumDuration, `${name} window is incomplete`);
    assert.match(window.sourceDigest, /^[a-f0-9]{64}$/, `${name} source digest is invalid`);
    for (const metric of ["read", "heartbeat"] as const) {
      const count = window[`${metric}Samples`], timing = window[`${metric}P99Ms`];
      assert.ok(Number.isInteger(count) && count >= NETWORK_PROBE_MIN_SAMPLES, `${name} needs at least ${NETWORK_PROBE_MIN_SAMPLES} ${metric} samples`);
      assert.ok(timing !== null && Number.isFinite(timing) && timing >= 0, `${name} ${metric} timing is invalid`);
    }
  }
  assert.equal(measurement.sourceDigest, baseline.sourceDigest, "baseline and measurement source differ");
  const multiplier = 1.25, noiseAllowanceMs = 5, deadlineSafetyFraction = 0.5;
  const deadlineBudgetMs = heartbeatTimeoutMs * deadlineSafetyFraction;
  // The absolute ceiling remains tied to the fixture's lease, so slow baseline
  // samples cannot certify latencies that approach attempt expiry.
  const readBudgetMs = Math.min(baseline.readP99Ms! * multiplier + noiseAllowanceMs, deadlineBudgetMs);
  const heartbeatBudgetMs = Math.min(baseline.heartbeatP99Ms! * multiplier + noiseAllowanceMs, deadlineBudgetMs);
  assert.ok(baseline.readP99Ms! < deadlineBudgetMs && baseline.heartbeatP99Ms! < deadlineBudgetMs, "baseline exceeds fixture deadline safety budget");
  return {
    schemaVersion: 1, method: "separate initial window; identical controlled workload" as const,
    multiplier, noiseAllowanceMs, minimumSamples: NETWORK_PROBE_MIN_SAMPLES,
    heartbeatTimeoutMs, deadlineSafetyFraction, deadlineBudgetMs, readBudgetMs, heartbeatBudgetMs,
    passed: measurement.readP99Ms! <= readBudgetMs && measurement.heartbeatP99Ms! <= heartbeatBudgetMs,
  };
}
