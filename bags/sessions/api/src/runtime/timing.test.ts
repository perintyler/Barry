import { expect, it } from "vitest";
import { timed, timingHeader, messageTimingHeader } from "./timing.js";
it("records success and failure durations without changing their result", async () => {
  const timings: Record<string, number> = {};
  expect(await timed(timings, "env_ms", async () => 5)).toBe(5);
  expect(timings.env_ms).toBeGreaterThanOrEqual(0);
  await expect(timed(timings, "failure_ms", async () => { throw new Error("no"); })).rejects.toThrow("no");
  expect(timings.failure_ms).toBeGreaterThanOrEqual(0);
});
it("exposes finite milliseconds and the warm flag in an HTTP header", () => {
  expect(timingHeader({ prepare_total_ms: 12.34, warm_hit: 1 })).toBe("prepare_total=12.3;warm=1");
});

it("reports a prepared first turn without startup stages even before its queue runs", () => {
  expect(messageTimingHeader({ prepare_total_ms: 1, harness_create_ms: 2, harness_ready_ms: 3 }, true)).toBe("prepare_total=1.0;warm=1");
});
