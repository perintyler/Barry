/**
 * One-off schedules — the guarantees carried over from the services bag's
 * scheduled-work store, each with the case that would break it.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { setDb, closeDb, getDb } from "./db.js";
import {
  cancelAtSchedule,
  claimDue,
  claimOne,
  countRunning,
  createAtSchedule,
  dueIds,
  finishAttempt,
  getAtSchedule,
  IdempotencyConflictError,
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_RECOVERIES,
  recoverOrphans,
  type RecoveryDeps,
} from "./at-schedules.js";

beforeEach(() => setDb(new Database(":memory:")));
afterAll(() => closeDb());

const T0 = new Date("2026-09-24T10:00:00Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const RUNNER = { runnerPid: 111, runnerStartedAt: 1 };

function create(overrides: Partial<Parameters<typeof createAtSchedule>[0]> = {}) {
  return createAtSchedule(
    { bag: "followups", action: "followups:followup", inputs: { sessionId: "s1" }, dueAt: T0, ...overrides },
    T0,
  ).schedule;
}

function claim(now = T0) {
  return claimDue({ now, limit: 4, ...RUNNER });
}

function recovery(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    selfPid: 999,
    probe: () => "gone",
    kill: () => {},
    closedRun: () => null,
    openRun: () => false,
    now: later(10),
    ...overrides,
  };
}

describe("creating", () => {
  it("keeps the inputs exactly as given", () => {
    const o = create({ inputs: { session_id: "s1", nested: { a: [1, 2] } } });
    expect(getAtSchedule(o.id)?.inputs).toEqual({ session_id: "s1", nested: { a: [1, 2] } });
  });

  it("returns the same schedule for a repeated request with the same key", () => {
    const first = createAtSchedule({ bag: "b", action: "b:x", dueAt: T0, idempotencyKey: "k" }, T0);
    const again = createAtSchedule({ bag: "b", action: "b:x", dueAt: T0, idempotencyKey: "k" }, T0);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, schedule: { id: first.schedule.id } });
  });

  it("refuses the same key for a different request, writing nothing", () => {
    create({ idempotencyKey: "k" });
    expect(() => create({ idempotencyKey: "k", inputs: { sessionId: "other" } })).toThrow(IdempotencyConflictError);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM one_off").get() as { n: number }).n).toBe(1);
  });

  it("preserves identityId, bags, and bounds in permissions", () => {
    const o = create({ permissions: { identity: "barry", identityId: 42, bags: ["fs"], bounds: ["fs:read"] } });
    expect(getAtSchedule(o.id)?.permissions).toEqual({ identity: "barry", identityId: 42, bags: ["fs"], bounds: ["fs:read"] });
  });

  it("normalizes legacy permissions_json with traits on read without altering request_hash", () => {
    const legacyPerms = { identity: "bux", traits: ["git:read"] };
    const precomputedHash = createHash("sha256")
      .update(JSON.stringify(["followups", "followups:followup", null, { sessionId: "s1" }, T0.toISOString(), 600, 1, legacyPerms]))
      .digest("hex");
    getDb()
      .prepare(
        `INSERT INTO one_off (id, bag, action, inline_action, job, caller_session_id, inputs_json, due_at, created_at, updated_at, status,
           idempotency_key, request_hash, timeout_s, retry_attempts, created_by, permissions_json)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 'pending', ?, ?, 600, 1, NULL, ?)`,
      )
      .run(
        "sch_legacy",
        "followups",
        "followups:followup",
        JSON.stringify({ sessionId: "s1" }),
        T0.toISOString(),
        T0.toISOString(),
        T0.toISOString(),
        "legacy-key",
        precomputedHash,
        JSON.stringify(legacyPerms),
      );
    const loaded = getAtSchedule("sch_legacy");
    expect(loaded?.permissions).toEqual({ identity: "bux", bags: ["git"], bounds: ["git:read"] });
    const row = getDb().prepare("SELECT request_hash FROM one_off WHERE id = ?").get("sch_legacy") as { request_hash: string };
    expect(row.request_hash).toBe(precomputedHash);
  });
});

describe("claiming", () => {
  it("does not claim what is not yet due", () => {
    create({ dueAt: later(60) });
    expect(claim()).toEqual([]);
    expect(claim(later(60))).toHaveLength(1);
  });

  it("claims a due one-off once, however many times it is asked", () => {
    create();
    expect(claim()).toHaveLength(1);
    expect(claim()).toEqual([]);
  });

  it("lets cancel and claim race, with exactly one winner", () => {
    const a = create();
    const b = create({ idempotencyKey: "second" });
    expect(cancelAtSchedule(a.id)).toEqual({ cancelled: true, status: "cancelled" });
    const claims = claim();
    expect(claims.map((c) => c.schedule.id)).toEqual([b.id]);
    // The claim won: the cancel can only ask the running attempt to stop.
    expect(cancelAtSchedule(b.id, T0, () => {})).toEqual({ cancelled: false, status: "running", cancelRequested: true });
  });

  it("loses to a cancel that lands between finding it due and claiming it", () => {
    const o = create();
    expect(dueIds(T0, 4)).toEqual([o.id]);
    cancelAtSchedule(o.id);
    expect(claimOne(o.id, { now: T0, ...RUNNER })).toBeNull();
    expect(getAtSchedule(o.id)?.status).toBe("cancelled");
  });

  it("respects the limit", () => {
    for (let i = 0; i < 6; i++) create({ idempotencyKey: `k${i}` });
    expect(claimDue({ now: T0, limit: 4, ...RUNNER })).toHaveLength(4);
  });
});

describe("finishing", () => {
  it("records success once; a second finish of the same attempt changes nothing", () => {
    const o = create();
    const [{ attemptId }] = claim();
    expect(finishAttempt({ scheduleId: o.id, attemptId, outcome: "succeeded", exitCode: 0, runId: "arn_1" })).toBe(true);
    expect(finishAttempt({ scheduleId: o.id, attemptId, outcome: "failed", exitCode: 1 })).toBe(false);
    expect(getAtSchedule(o.id)).toMatchObject({ status: "succeeded", attempts: [{ outcome: "succeeded", runId: "arn_1" }] });
  });

  it("does not retry a failure unless the schedule asked", () => {
    const o = create();
    const [{ attemptId }] = claim();
    finishAttempt({ scheduleId: o.id, attemptId, outcome: "failed", exitCode: 2 });
    expect(getAtSchedule(o.id)).toMatchObject({ status: "failed", reason: "exited 2", failures: 1 });
  });

  it("retries with backoff when asked, until the attempts run out", () => {
    const o = create({ retryAttempts: 2 });
    const [first] = claim();
    finishAttempt({ scheduleId: o.id, attemptId: first.attemptId, outcome: "failed", exitCode: 1, now: T0, random: () => 0.5 });
    const retried = getAtSchedule(o.id)!;
    expect(retried.status).toBe("pending");
    expect(retried.dueAt).toEqual(later(30));
    expect(claim(later(29))).toEqual([]);
    const [second] = claim(later(30));
    finishAttempt({ scheduleId: o.id, attemptId: second.attemptId, outcome: "timed_out", now: later(40) });
    expect(getAtSchedule(o.id)).toMatchObject({ status: "failed", failures: 2, attempts: [{ number: 1 }, { number: 2, outcome: "timed_out" }] });
  });

  it("never retries an unavailable action", () => {
    const o = create({ retryAttempts: 5 });
    const [{ attemptId }] = claim();
    finishAttempt({ scheduleId: o.id, attemptId, outcome: "unavailable", reason: "unavailable: no action followups:followup" });
    expect(getAtSchedule(o.id)).toMatchObject({ status: "failed", reason: "unavailable: no action followups:followup" });
  });
});

describe("recovering a dead runner's attempts", () => {
  it("leaves its own in-flight attempts alone", () => {
    const o = create();
    claimDue({ now: T0, limit: 1, runnerPid: 999, runnerStartedAt: 1 });
    expect(recoverOrphans(recovery())).toEqual([]);
    expect(getAtSchedule(o.id)?.status).toBe("running");
  });

  it("re-queues a script attempt whose runner is gone, killing its process group first", () => {
    const o = create();
    const [{ attemptId }] = claim();
    getDb().prepare("UPDATE one_off_attempt SET process_group = 4242 WHERE id = ?").run(attemptId);
    const killed: Array<number | null> = [];
    expect(recoverOrphans(recovery({ kill: (g) => killed.push(g), openRun: () => true }))).toEqual([{ id: o.id, action: "requeued" }]);
    expect(killed).toEqual([4242]);
    expect(getAtSchedule(o.id)).toMatchObject({ status: "pending", recoveries: 1, attempts: [{ outcome: "abandoned" }] });
    // The abandoned attempt cannot record an outcome over its replacement.
    expect(finishAttempt({ scheduleId: o.id, attemptId, outcome: "succeeded" })).toBe(false);
  });

  it("leaves a live runner alone — two schedulers must not both act", () => {
    const o = create();
    claim();
    expect(recoverOrphans(recovery({ probe: () => "alive" }))).toEqual([{ id: o.id, action: "left-alive" }]);
    expect(getAtSchedule(o.id)?.status).toBe("running");
  });

  it("marks it uncertain rather than risk a second copy when identity is unreadable", () => {
    const o = create();
    claim();
    recoverOrphans(recovery({ probe: () => "unknown" }));
    expect(getAtSchedule(o.id)).toMatchObject({ status: "uncertain", reason: expect.stringMatching(/could not tell/) });
  });

  it("gives up as uncertain after its recovery budget", () => {
    const o = create();
    // Re-queued work is due at the moment it was recovered.
    for (let i = 0; i < MAX_RECOVERIES; i++) {
      expect(claim(later(10))).toHaveLength(1);
      recoverOrphans(recovery());
    }
    expect(getAtSchedule(o.id)?.status).toBe("pending");
    claim(later(10));
    recoverOrphans(recovery());
    expect(getAtSchedule(o.id)).toMatchObject({ status: "uncertain", reason: expect.stringMatching(/died 4 times/) });
  });

  it("records the outcome of a run that finished after its runner died", () => {
    const o = create();
    claim();
    recoverOrphans(recovery({ closedRun: () => ({ runId: "arn_9", succeeded: true, exitCode: 0, summary: "Exited 0" }) }));
    expect(getAtSchedule(o.id)).toMatchObject({ status: "succeeded", attempts: [{ outcome: "succeeded", runId: "arn_9" }] });
  });

  it("waits out an agent run still open in the API, then calls it uncertain", () => {
    const o = create({ timeoutS: 60 });
    claim();
    expect(recoverOrphans(recovery({ openRun: () => true, now: later(30) }))).toEqual([{ id: o.id, action: "left-alive" }]);
    recoverOrphans(recovery({ openRun: () => true, now: later(60 + 121) }));
    expect(getAtSchedule(o.id)).toMatchObject({ status: "uncertain", reason: expect.stringMatching(/never finished/) });
  });
});

describe("job one-offs", () => {
  const job = (overrides: Partial<Parameters<typeof createAtSchedule>[0]> = {}) =>
    create({ action: null, job: "ops:reaper", ...overrides });

  it("store the job and the calling session", () => {
    const o = job({ callerSessionId: "sess-1" });
    expect(getAtSchedule(o.id)).toMatchObject({ job: "ops:reaper", action: null, callerSessionId: "sess-1", cancelRequestedAt: null });
  });

  it("run exactly one thing", () => {
    expect(() => create({ job: "ops:reaper" })).toThrow(/exactly one of/);
    expect(() => create({ action: null })).toThrow(/exactly one of/);
  });

  it("refuse oversized inputs before storing anything", () => {
    expect(() => job({ inputs: { blob: "x".repeat(MAX_INPUT_BYTES) } })).toThrow(InputTooLargeError);
    expect(dueIds(T0, 10)).toEqual([]);
  });

  it("keep an action one-off's request hash as it was, so its key still replays", () => {
    const first = createAtSchedule({ bag: "b", action: "b:x", dueAt: T0, idempotencyKey: "k" }, T0);
    const row = getDb().prepare("SELECT request_hash FROM one_off WHERE id = ?").get(first.schedule.id) as { request_hash: string };
    // The hash an action one-off stored before jobs existed: the same eight fields, nothing appended.
    expect(row.request_hash).toBe(createHash("sha256").update(JSON.stringify(["b", "b:x", null, {}, T0.toISOString(), 600, 1, {}])).digest("hex"));
  });

  it("draw on their own budget", () => {
    const a = create();
    const j = job();
    expect(dueIds(T0, 10, "action")).toEqual([a.id]);
    expect(dueIds(T0, 10, "job")).toEqual([j.id]);
    expect(claimDue({ now: T0, limit: 4, kind: "job", ...RUNNER }).map((c) => c.schedule.id)).toEqual([j.id]);
    expect(countRunning("job")).toBe(1);
    expect(countRunning("action")).toBe(0);
  });

  it("number their attempts from 1, counting retries", () => {
    const o = job({ retryAttempts: 2 });
    const first = claimOne(o.id, { now: T0, ...RUNNER })!;
    expect(first.attempt).toBe(1);
    finishAttempt({ scheduleId: o.id, attemptId: first.attemptId, outcome: "failed", exitCode: 1, now: T0, random: () => 0.5 });
    const second = claimOne(o.id, { now: later(3600), ...RUNNER })!;
    expect(second.attempt).toBe(2);
  });

  it("never retry work whose output broke its contract", () => {
    const o = job({ retryAttempts: 3 });
    const { attemptId } = claimOne(o.id, { now: T0, ...RUNNER })!;
    finishAttempt({ scheduleId: o.id, attemptId, outcome: "validation_failed", exitCode: 0, reason: "output did not match", now: T0 });
    expect(getAtSchedule(o.id)).toMatchObject({ status: "failed", reason: "output did not match" });
  });
});

describe("cancelling a running one-off", () => {
  it("kills its process group and ends it cancelled, not failed or retried", () => {
    const o = create({ retryAttempts: 3 });
    const { attemptId } = claimOne(o.id, { now: T0, ...RUNNER })!;
    getDb().prepare("UPDATE one_off_attempt SET process_group = 4242 WHERE id = ?").run(attemptId);
    const killed: Array<number | null> = [];
    expect(cancelAtSchedule(o.id, later(1), (group) => killed.push(group))).toEqual({ cancelled: false, status: "running", cancelRequested: true });
    expect(killed).toEqual([4242]);
    finishAttempt({ scheduleId: o.id, attemptId, outcome: "failed", exitCode: null, now: later(2) });
    expect(getAtSchedule(o.id)).toMatchObject({ status: "cancelled", reason: "cancelled while running" });
  });

  it("is not restarted when its runner died after the cancel", () => {
    const o = create();
    claimOne(o.id, { now: T0, runnerPid: 222, runnerStartedAt: 1 });
    cancelAtSchedule(o.id, later(1), () => {});
    expect(recoverOrphans(recovery())).toEqual([{ id: o.id, action: "finalized" }]);
    expect(getAtSchedule(o.id)?.status).toBe("cancelled");
  });
});
