import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { BagSchedule } from "@barry-rocks/sdk/internal/schedules";
import { setDb, closeDb } from "./db.js";
import { getState, readHeartbeat, updateState } from "./store.js";
import { Scheduler, MAX_AT_SCHEDULES_RUNNING, MAX_JOB_RUNS_RUNNING, type FireOutcome, type SchedulerDeps, type Transition, type AtScheduleResult } from "./scheduler.js";
import { createAtSchedule, getAtSchedule } from "./at-schedules.js";
import type { ScheduleEntry } from "./registry.js";

afterAll(() => closeDb());



function entry(overrides: Partial<BagSchedule> = {}, name = "job"): ScheduleEntry {
  return {
    id: `ops/${name}`,
    bag: "ops",
    name,
    dir: "/bags/ops",
    schedule: {
      trigger: { kind: "cron", expression: "* * * * *", timezone: "UTC" },
      payload: { kind: "ref", ref: "ops:x" },
      overlap: "skip",
      catchUp: "once",
      enabled: true,
      ...overrides,
    },
  };
}

const scriptAction: ActionMeta = {
  source: "bag",
  name: "x",
  bag: "ops",
  qualifiedName: "ops:x",
  dir: "/bags/ops",
  description: "d",
  run: { command: "true", args: [] },
  requires: { tools: [], secrets: [], bins: [] },
  instructions: [],
  steps: [],
  slashCommand: false,
  scripts: [],
  context: "none",
  legacySkill: false,
  bagAccess: "enabled",
  shadowed: false,
};

/** A harness: fake clock, runs that finish when told, recorded announcements. */
function harness(entries: ScheduleEntry[], opts: { announceWorks?: boolean; errors?: string[] } = {}) {
  let login = "login-event-1";
  let clock = new Date("2026-09-24T10:00:00Z");
  const fires: string[] = [];
  const pending: Array<(o: FireOutcome) => void> = [];
  const announced: Array<{ id: string; transition: Transition }> = [];
  let nextOutcome: FireOutcome = { status: "complete", runId: "arn_1", summary: "ok" };
  let resolveError: Error | null = null;
  let announceWorks = opts.announceWorks ?? true;
  let settleImmediately = true;

  const deps: SchedulerDeps = {
    listSchedules: async () => ({ schedules: entries, errors: opts.errors ?? [] }),
    resolveAction: async () => {
      if (resolveError) throw resolveError;
      return scriptAction;
    },
    runScript: (_a, e) => {
      fires.push(e.id);
      if (settleImmediately) return Promise.resolve(nextOutcome);
      return new Promise((resolve) => pending.push(resolve));
    },
    runAgent: async (e) => {
      fires.push(e.id);
      return nextOutcome;
    },
    runJob: async (e) => {
      fires.push(`job:${e.id}`);
      return nextOutcome;
    },
    announce: async (e, transition) => {
      if (!announceWorks) return false;
      announced.push({ id: e.id, transition });
      return true;
    },
    runAtSchedule: async () => ({ outcome: "succeeded", exitCode: 0, runId: null }),
    recoverAtSchedules: () => {},
    runner: { pid: process.pid, startedAt: null },
    loginEventId: () => login,
    now: () => clock,
  };
  const scheduler = new Scheduler(deps);
  return {
    scheduler,
    setLogin: (event: string) => { login = event; },
    fires,
    announced,
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    tick: async () => {
      await scheduler.tick();
      await Promise.all(scheduler.running);
    },
    tickNoWait: () => scheduler.tick(),
    hold: () => {
      settleImmediately = false;
    },
    release: async (o: FireOutcome = nextOutcome) => {
      pending.splice(0).forEach((r) => r(o));
      await Promise.all(scheduler.running);
    },
    setOutcome: (o: FireOutcome) => {
      nextOutcome = o;
    },
    failResolve: (e: Error | null) => {
      resolveError = e;
    },
    setAnnounce: (works: boolean) => {
      announceWorks = works;
    },
  };
}

beforeEach(() => setDb(new Database(":memory:")));

describe("Scheduler", () => {
  it("fires a job schedule as a job run, recording its outcome like any fire", async () => {
    const h = harness([entry({ payload: { kind: "job", ref: "reaper" } })]);
    h.setOutcome({ status: "failed", runId: "arn_9", summary: "exited 1" });
    await h.tick();
    h.advance(60);
    await h.tick();
    expect(h.fires).toEqual(["job:ops/job"]);
    expect(getState("ops/job")).toMatchObject({ last_status: "failed", last_run_id: "arn_9", consecutive_failures: 1 });
  });

  it("waits one interval after first sight, then fires, then waits again", async () => {
    const h = harness([entry()]);
    await h.tick();
    expect(h.fires).toEqual([]);
    h.advance(59);
    await h.tick();
    expect(h.fires).toEqual([]);
    h.advance(1);
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
    h.advance(30);
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
  });

  it("skips a fire that lands while the last run is still going", async () => {
    const h = harness([entry()]);
    await h.tick();
    h.hold();
    h.advance(60);
    await h.tickNoWait();
    h.advance(60);
    await h.tickNoWait();
    expect(h.fires).toEqual(["ops/job"]);
    expect(getState("ops/job")?.skipped_fires).toBe(1);
    await h.release();
  });

  it("queues exactly one extra run when overlap is queue", async () => {
    const h = harness([entry({ overlap: "queue" })]);
    await h.tick();
    h.hold();
    h.advance(60);
    await h.tickNoWait();
    h.advance(60);
    await h.tickNoWait();
    h.advance(60);
    await h.tickNoWait();
    expect(h.fires).toEqual(["ops/job"]);
    await h.release();
    // The queued run started when the first finished; release it too.
    expect(h.fires).toEqual(["ops/job", "ops/job"]);
    await h.release();
    expect(h.fires).toHaveLength(2);
  });

  it("catches up a missed fire once after a long gap, not once per missed interval", async () => {
    const h = harness([entry()]);
    await h.tick();
    h.advance(7 * 24 * 3600);
    await h.tick();
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
  });

  it("records a missed fire and does not run it when catch_up is none", async () => {
    const h = harness([entry({ catchUp: "none" })]);
    await h.tick();
    h.advance(3600);
    await h.tick();
    expect(h.fires).toEqual([]);
    expect(getState("ops/job")?.missed_fires).toBe(1);
  });

  it("does not fire a paused or disabled schedule", async () => {
    const h = harness([entry({}, "paused"), entry({ enabled: false }, "off")]);
    await h.tick();
    updateState("ops/paused", { paused: true });
    h.advance(120);
    await h.tick();
    expect(h.fires).toEqual([]);
  });

  it("announces the first failure once, and the recovery", async () => {
    const h = harness([entry()]);
    await h.tick();
    h.setOutcome({ status: "failed", runId: "arn_2", summary: "exited 1" });
    h.advance(60);
    await h.tick();
    h.advance(60);
    await h.tick();
    expect(h.announced).toEqual([{ id: "ops/job", transition: "failure" }]);
    expect(getState("ops/job")?.consecutive_failures).toBe(2);
    h.setOutcome({ status: "complete", runId: "arn_3", summary: "ok" });
    h.advance(60);
    await h.tick();
    expect(h.announced.map((a) => a.transition)).toEqual(["failure", "recovery"]);
    expect(getState("ops/job")?.consecutive_failures).toBe(0);
  });

  it("retries a failure alert that could not be delivered", async () => {
    const h = harness([entry()], { announceWorks: false });
    await h.tick();
    h.setOutcome({ status: "failed", runId: "arn_2", summary: "exited 1" });
    h.advance(60);
    await h.tick();
    expect(getState("ops/job")?.failure_announced).toBe(false);
    h.setAnnounce(true);
    await h.tick();
    expect(h.announced).toEqual([{ id: "ops/job", transition: "failure" }]);
    expect(getState("ops/job")?.failure_announced).toBe(true);
  });

  it("records a fire that could not start as a failure, and says why", async () => {
    const h = harness([entry()]);
    await h.tick();
    h.failResolve(new Error('schedule ops/job runs action "ops:x", which does not exist'));
    h.advance(60);
    await h.tick();
    const state = getState("ops/job");
    expect(state?.last_status).toBe("failed");
    expect(state?.last_summary).toMatch(/does not exist/);
    expect(h.announced).toEqual([{ id: "ops/job", transition: "failure" }]);
  });

  it("recomputes the due time when the trigger changes", async () => {
    const entries = [entry()];
    const h = harness(entries);
    await h.tick();
    entries[0] = entry({ trigger: { kind: "cron", expression: "0 * * * *", timezone: "UTC" } });
    h.scheduler.invalidate();
    h.advance(60);
    await h.tick();
    expect(h.fires).toEqual([]);
    h.advance(3600);
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
  });

  it("runs a one-off at once and never again", async () => {
    const h = harness([entry({ trigger: { kind: "at", time: "2026-09-24T10:05:00Z" } })]);
    await h.tick();
    h.advance(300);
    await h.tick();
    h.advance(3600);
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
  });

  it("runs an at: login schedule once per login event, not once per scheduler start", async () => {
    const h = harness([entry({ trigger: { kind: "login" } })]);
    await h.tick();
    await h.tick();
    expect(h.fires).toEqual(["ops/job"]);
    // A second scheduler process after a restart, same login event: still done.
    const again = harness([entry({ trigger: { kind: "login" } })]);
    await again.tick();
    expect(again.fires).toEqual([]);
    again.setLogin("login-event-2");
    await again.tick();
    expect(again.fires).toEqual(["ops/job"]);
    again.setLogin("login-event-1");
    await again.tick();
    expect(again.fires).toEqual(["ops/job"]);
  });

  it("does not infer an unavailable login event from scheduler startup", async () => {
    const h = harness([entry({ trigger: { kind: "login" } })]);
    h.setLogin("");
    await h.tick();
    await h.tick();
    expect(h.fires).toEqual([]);
  });

  it("writes a heartbeat carrying load errors, every tick", async () => {
    const h = harness([entry()], { errors: ["bag broken: invalid manifest"] });
    await h.tick();
    const beat = readHeartbeat();
    expect(beat?.schedules).toBe(1);
    expect(beat?.load_errors).toEqual(["bag broken: invalid manifest"]);
  });
});

describe("Scheduler — one-offs", () => {
  const T0 = new Date("2026-09-24T10:00:00Z");

  function atScheduleHarness(run: (id: string) => Promise<AtScheduleResult>) {
    const calls: Array<{ id: string; attemptId: string; attempt: number }> = [];
    let recoveries = 0;
    let clock = T0;
    const scheduler = new Scheduler({
      listSchedules: async () => ({ schedules: [], errors: [] }),
      resolveAction: async () => scriptAction,
      runScript: async () => ({ status: "complete", runId: null, summary: "" }),
      runAgent: async () => ({ status: "complete", runId: null, summary: "" }),
      runJob: async () => ({ status: "complete", runId: null, summary: "" }),
      announce: async () => true,
      runAtSchedule: (o, attemptId, attempt) => {
        calls.push({ id: o.id, attemptId, attempt });
        return run(o.id);
      },
      recoverAtSchedules: () => {
        recoveries++;
      },
      runner: { pid: 4321, startedAt: 7 },
      loginEventId: () => null,
      now: () => clock,
    });
    return {
      scheduler,
      calls,
      recoveries: () => recoveries,
      advance: (s: number) => { clock = new Date(clock.getTime() + s * 1000); },
      tick: async () => { await scheduler.tick(); await Promise.all(scheduler.running); },
    };
  }

  const make = (dueIn = 0, extra: Partial<Parameters<typeof createAtSchedule>[0]> = {}) =>
    createAtSchedule({ bag: "b", action: "b:x", dueAt: new Date(T0.getTime() + dueIn * 1000), ...extra }, T0).schedule;

  it("runs a due one-off once, recording the attempt and its run", async () => {
    const h = atScheduleHarness(async () => ({ outcome: "succeeded", exitCode: 0, runId: "arn_7" }));
    const o = make(30);
    await h.tick();
    expect(h.calls).toEqual([]);
    h.advance(30);
    await h.tick();
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(getAtSchedule(o.id)).toMatchObject({ status: "succeeded", attempts: [{ outcome: "succeeded", runId: "arn_7" }] });
  });

  it("recovers orphans on every tick, before claiming", async () => {
    const h = atScheduleHarness(async () => ({ outcome: "succeeded", exitCode: 0, runId: null }));
    await h.tick();
    await h.tick();
    expect(h.recoveries()).toBe(2);
  });

  it("closes an attempt whose runner threw, as failed with the reason", async () => {
    const h = atScheduleHarness(async () => { throw new Error("boom"); });
    const o = make();
    await h.tick();
    expect(getAtSchedule(o.id)).toMatchObject({ status: "failed", reason: "runner error: boom" });
  });

  it("runs at most MAX_AT_SCHEDULES_RUNNING at once; the rest stay pending", async () => {
    const release: Array<() => void> = [];
    const h = atScheduleHarness(() => new Promise((resolve) => release.push(() => resolve({ outcome: "succeeded", exitCode: 0, runId: null }))));
    for (let i = 0; i < MAX_AT_SCHEDULES_RUNNING + 2; i++) make(0, { idempotencyKey: `k${i}` });
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.calls).toHaveLength(MAX_AT_SCHEDULES_RUNNING);
    release.splice(0).forEach((r) => r());
    await Promise.all(h.scheduler.running);
    await h.scheduler.tick();
    expect(h.calls).toHaveLength(MAX_AT_SCHEDULES_RUNNING + 2);
    release.splice(0).forEach((r) => r());
    await Promise.all(h.scheduler.running);
  });

  it("gives job runs a budget of their own, so neither kind starves the other", async () => {
    const release: Array<() => void> = [];
    const h = atScheduleHarness(() => new Promise((resolve) => release.push(() => resolve({ outcome: "succeeded", exitCode: 0, runId: null }))));
    for (let i = 0; i < MAX_JOB_RUNS_RUNNING + 1; i++) make(0, { action: null, job: "b:sweep", idempotencyKey: `j${i}` });
    for (let i = 0; i < MAX_AT_SCHEDULES_RUNNING + 1; i++) make(0, { idempotencyKey: `a${i}` });
    await h.scheduler.tick();
    // A full job budget left every action slot free, and the other way round.
    expect(h.calls).toHaveLength(MAX_JOB_RUNS_RUNNING + MAX_AT_SCHEDULES_RUNNING);
    release.splice(0).forEach((r) => r());
    await Promise.all(h.scheduler.running);
    await h.scheduler.tick();
    expect(h.calls).toHaveLength(MAX_JOB_RUNS_RUNNING + MAX_AT_SCHEDULES_RUNNING + 2);
    release.splice(0).forEach((r) => r());
    await Promise.all(h.scheduler.running);
  });

  it("hands the runner the attempt number", async () => {
    const h = atScheduleHarness(async () => ({ outcome: "succeeded", exitCode: 0, runId: null }));
    make();
    await h.tick();
    expect(h.calls.map((c) => c.attempt)).toEqual([1]);
  });
});
