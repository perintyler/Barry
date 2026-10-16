import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "http";
import Database from "better-sqlite3";
import type { ScheduleEntry } from "@barry-rocks/schedules-bag";

vi.mock("@barry-rocks/schedules-bag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/schedules-bag")>()),
  resolveScheduleAccess: vi.fn(async () => ({})),
  resolveAtScheduleAccess: vi.fn(async () => ({})),
  listSchedules: vi.fn(),
  findSchedule: vi.fn(),
  resolveScheduleAction: vi.fn(),
  resolveAtScheduleAction: vi.fn(),
}));
vi.mock("./actions.js", () => ({ executeDetached: vi.fn() }));
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: vi.fn(async () => ({ bags: [] })),
}));

import { schedulesRouter } from "./schedules.js";
import { executeDetached } from "./actions.js";
import { findSchedule, listSchedules, resolveAtScheduleAction, resolveScheduleAction } from "@barry-rocks/schedules-bag";
import { claimOne, createAtSchedule } from "@barry-rocks/schedules-bag";
import { resolveAtScheduleAccess } from "@barry-rocks/schedules-bag";
import { setDb, closeDb } from "@barry-rocks/schedules-bag";
import { getState } from "@barry-rocks/schedules-bag";

const entry: ScheduleEntry = {
  id: "ops/digest",
  bag: "ops",
  name: "digest",
  dir: "/bags/ops",
  schedule: {
    trigger: { kind: "cron", expression: "0 9 * * 1" },
    payload: { kind: "ref", ref: "ops:digest" },
    inputs: { channel: "eng" },
    identity: "bux",
    overlap: "skip",
    catchUp: "once",
    enabled: true,
  },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/schedules", schedulesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  closeDb();
});

beforeEach(() => {
  vi.clearAllMocks();
  setDb(new Database(":memory:"));
  vi.mocked(findSchedule).mockImplementation(async (id) => (id === entry.id ? entry : null));
  vi.mocked(listSchedules).mockResolvedValue({ schedules: [entry], errors: [] });
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${baseUrl}/schedules${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("/schedules", () => {
  it("runs a schedule's action with its inputs, recorded against the schedule", async () => {
    vi.mocked(resolveScheduleAction).mockResolvedValue({ qualifiedName: "ops:digest" } as never);
    vi.mocked(executeDetached).mockResolvedValue({ status: 200, body: { run_id: "arn_1", status: "complete" } });

    const res = await post("/ops/digest/run", { trigger: "schedule" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: "arn_1", status: "complete" });
    expect(vi.mocked(executeDetached).mock.calls[0][1]).toEqual({
      inputs: { channel: "eng" },
      identity: "bux",
      executionContext: {},
      schedule_id: "ops/digest",
      trigger: "schedule",
    });
  });

  it("runs a standalone search bag schedule in the run URL and keeps its complete schedule id", async () => {
    const searchSchedule: ScheduleEntry = { ...entry, id: "session-vector-search/embed", bag: "session-vector-search", name: "embed" };
    vi.mocked(findSchedule).mockImplementation(async (id) => id === searchSchedule.id ? searchSchedule : null);
    vi.mocked(resolveScheduleAction).mockResolvedValue({ qualifiedName: "session-vector-search:embed" } as never);
    vi.mocked(executeDetached).mockResolvedValue({ status: 200, body: { run_id: "arn_extension", status: "complete" } });

    const res = await post("/session-vector-search/embed/run", { trigger: "schedule" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: "arn_extension", status: "complete" });
    expect(findSchedule).toHaveBeenCalledWith("session-vector-search/embed");
    expect(resolveScheduleAction).toHaveBeenCalledWith(searchSchedule);
    expect(vi.mocked(executeDetached).mock.calls[0][1]).toMatchObject({ schedule_id: "session-vector-search/embed" });
  });

  it("404s an unknown schedule instead of running anything", async () => {
    const res = await post("/ops/nope/run");
    expect(res.status).toBe(404);
    expect(executeDetached).not.toHaveBeenCalled();
  });

  it("pauses, and resumes with a fresh due time", async () => {
    expect((await post("/ops/digest/pause")).status).toBe(200);
    expect(getState("ops/digest")?.paused).toBe(true);
    expect((await post("/ops/digest/resume")).status).toBe(200);
    expect(getState("ops/digest")).toMatchObject({ paused: false, trigger_key: null });
  });

  it("refuses a runtime schedule that could never fire, before storing it", async () => {
    const res = await post("/", { name: "remind", spec: { cron: "99 * * * *", action: "ops:digest" } });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/minute/);
  });

  it("runs an action job a session started as that session, recorded as a job", async () => {
    vi.mocked(resolveAtScheduleAction).mockResolvedValue({ action: { qualifiedName: "ops:triage", context: "none", prompt: "p" } as never });
    vi.mocked(executeDetached).mockResolvedValue({ status: 200, body: { run_id: "arn_2", status: "complete" } });
    const { schedule } = createAtSchedule({ bag: "ops", action: null, job: "ops:triage", dueAt: new Date(), callerSessionId: "sess-1" });
    claimOne(schedule.id, { now: new Date(), runnerPid: 1, runnerStartedAt: null });

    expect((await post(`/once/${schedule.id}/run`, { attempt_id: "att_1" })).status).toBe(200);
    const [, body] = vi.mocked(executeDetached).mock.calls[0];
    expect(body).toMatchObject({ caller_session_id: "sess-1", schedule_id: schedule.id, trigger: "job" });
    expect(body).not.toHaveProperty("executionContext");
    expect(resolveAtScheduleAccess).not.toHaveBeenCalled();
  });

  it("reports a scheduler with no heartbeat as down in the listing", async () => {
    const res = await fetch(`${baseUrl}/schedules`);
    const body = await res.json();
    expect(body.scheduler.status).toBe("down");
    expect(body.schedules[0]).toMatchObject({ id: "ops/digest", trigger: "cron 0 9 * * 1", action: "ops:digest" });
  });
});
