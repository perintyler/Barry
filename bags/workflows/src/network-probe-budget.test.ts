import { expect, it } from "vitest";
import { networkLatencyBudget, type LatencyWindow } from "./network-probe-budget.js";

const baseline: LatencyWindow = { durationSeconds: 30, readP99Ms: 3, heartbeatP99Ms: 300, readSamples: 400, heartbeatSamples: 150, sourceDigest: "a".repeat(64) };
const measurement: LatencyWindow = { ...baseline, durationSeconds: 60, heartbeatSamples: 300 };

it("calibrates to a separate same-run baseline and fails a real injected latency regression", () => {
  const budget = networkLatencyBudget(baseline, { ...measurement, heartbeatP99Ms: 350 }, 60, 2000);
  expect(budget.passed).toBe(true);
  expect(budget.heartbeatBudgetMs).toBe(380);
  expect(networkLatencyBudget(baseline, { ...measurement, heartbeatP99Ms: 381 }, 60, 2000).passed).toBe(false);
  expect(networkLatencyBudget(baseline, { ...measurement, readP99Ms: 9 }, 60, 2000).passed).toBe(false);
  // A slow measurement cannot change its independent calibration budget.
  expect(networkLatencyBudget(baseline, { ...measurement, heartbeatP99Ms: 900 }, 60, 2000).heartbeatBudgetMs).toBe(380);
});

it("does not excuse missing samples, shortened windows, source changes or nonfinite timings", () => {
  for (const patch of [{ heartbeatSamples: 99 }, { readSamples: 99 }, { readSamples: 100.5 }, { durationSeconds: 29 }, { heartbeatP99Ms: NaN }, { readP99Ms: Infinity }, { readP99Ms: null }, { heartbeatP99Ms: -1 }, { sourceDigest: "invalid" }]) {
    expect(() => networkLatencyBudget({ ...baseline, ...patch }, measurement, 60, 2000)).toThrow();
  }
  expect(() => networkLatencyBudget(baseline, { ...measurement, durationSeconds: 59 }, 60, 2000)).toThrow(/incomplete/);
  expect(() => networkLatencyBudget(baseline, { ...measurement, sourceDigest: "b".repeat(64) }, 60, 2000)).toThrow(/source differ/);
});

it("keeps an absolute safety ceiling tied to the real heartbeat deadline", () => {
  expect(() => networkLatencyBudget({ ...baseline, heartbeatP99Ms: 1000 }, measurement, 60, 2000)).toThrow(/deadline safety/);
  const slowBaseline = { ...baseline, heartbeatP99Ms: 900 };
  expect(networkLatencyBudget(slowBaseline, { ...measurement, heartbeatP99Ms: 1001 }, 60, 2000).passed).toBe(false);
  expect(networkLatencyBudget(slowBaseline, measurement, 60, 2000).heartbeatBudgetMs).toBe(1000);
});
