import { afterEach, expect, it, vi } from "vitest";
import { Barry } from "@barry-rocks/sdk";
import { fakeActions, fakeSchedules } from "@barry-rocks/sdk/testing";
import { scheduleOverview } from "./schedules.js";
afterEach(() => Barry.reset());
it("preserves the page's wire shape while reading domain handles", async () => {
  const runs = vi.fn(async () => [{ id: "r1", status: "succeeded", startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T00:00:02Z", summary: "done" }] as never);
  const oneOffs = vi.fn(async () => []);
  Barry.use(fakeActions({ runs }), fakeSchedules({
    list: async () => [{ id: "ops/nightly", trigger: "cron", action: "ops:task", enabled: true, paused: false, nextFireAt: null, lastFiredAt: null, lastStatus: "complete", lastSummary: "done", lastRunId: "r1", consecutiveFailures: 0, skippedFires: 0, missedFires: 0 }],
    scheduler: async () => ({ status: "down", reason: "no heartbeat", heartbeatAt: null, loadErrors: ["missing"] }), oneOffs,
  }));
  const result = await scheduleOverview();
  expect(result.scheduler).toEqual({ status: "down", reason: "no heartbeat", heartbeat_at: null });
  expect(result.schedules[0]).toMatchObject({ last_run_id: "r1", consecutive_failures: 0, runs: [{ status: "complete", duration_ms: 2000, summary: "done" }] });
  expect(runs).toHaveBeenCalledWith({ schedule: "ops/nightly" }, { kind: "owner" });
  expect(oneOffs).toHaveBeenCalledWith({ status: "failed", limit: 10 }, { kind: "owner" });
});
it("reports an unavailable subject to the endpoint", async () => {
  await expect(scheduleOverview()).rejects.toMatchObject({ reason: "unavailable" });
});
