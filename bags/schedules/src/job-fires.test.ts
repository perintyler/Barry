import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { parseManifestObject } from "@barry-rocks/sdk/bags";
import { setDb, closeDb } from "./db.js";
import { claimOne, finishAttempt, getAtSchedule } from "./at-schedules.js";
import type { ScheduleEntry } from "./registry.js";

const manifest = parseManifestObject({
  name: "sessions",
  description: "A bag for testing",
  jobs: { reaper: { timeout: "10m", runs: { using: "node", main: "src/reaper.ts" } } },
  schedules: { reaper: { every: "5m", bags: ["bash", "sessions"], job: "reaper", inputs: {} } },
}, "sessions");
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: async () => ({ bags: [{ name: "sessions", jobs: Object.entries(manifest.jobs ?? {}).map(([name, job]) => ({ ...job, name, dir: "/bags/sessions" })) }] }),
}));
const { jobFireOutcome, runScheduledJob, scheduleJobRun } = await import("./job-fires.js");

beforeEach(() => setDb(new Database(":memory:")));
afterAll(() => closeDb());

const entry: ScheduleEntry = { id: "sessions/reaper", bag: "sessions", name: "reaper", dir: "/bags/sessions", schedule: manifest.schedules.reaper };
const AT = new Date("2026-10-07T10:05:00Z");

describe("a job schedule's fire", () => {
  it("is a job one-off keyed by schedule and fire time, carrying the schedule's permissions and the job's timeout", async () => {
    const scheduled = await scheduleJobRun(entry, AT);
    expect(scheduled).toMatchObject({
      bag: "sessions", job: "sessions:reaper", action: null, idempotencyKey: "sessions/reaper@2026-10-07T10:05:00.000Z",
      timeoutS: 600, createdBy: "schedule", permissions: { bags: ["bash", "sessions"] },
    });
    // A repeated fire after a crash is the same run.
    expect((await scheduleJobRun(entry, AT)).id).toBe(scheduled.id);
  });

  it("waits for the run and reports it as the schedule's outcome", async () => {
    const fired = runScheduledJob(entry, AT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [pending] = [getAtSchedule((await scheduleJobRun(entry, AT)).id)!];
    const claim = claimOne(pending.id, { now: AT, runnerPid: 1, runnerStartedAt: null })!;
    finishAttempt({ scheduleId: pending.id, attemptId: claim.attemptId, outcome: "failed", exitCode: 2, runId: "arn_3", reason: "exited 2" });
    expect(await fired).toEqual({ status: "failed", runId: "arn_3", summary: "exited 2" });
  });

  it("treats only success as complete", () => {
    expect(jobFireOutcome({ status: "succeeded", reason: null, attempts: [] } as never)).toEqual({ status: "complete", runId: null, summary: "" });
  });
});
