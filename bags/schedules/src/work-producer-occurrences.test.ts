import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BagSchedule } from "@barry-rocks/sdk/internal/schedules";
import { closeDb, getDb, setDb } from "./db.js";
import { getState } from "./store.js";
import type { ScheduleEntry } from "./registry.js";
import { createAtSchedule, getAtSchedule } from "./at-schedules.js";
import {
  DispatchBindingError,
  OccurrenceConflictError,
  abandonedDispatches,
  beginDispatch,
  bindAuthority,
  claimLoginOccurrence,
  dueOccurrences,
  getOccurrence,
  markAccepted,
  markRefused,
  markUnknown,
  newScheduleOccurrence,
  occurrenceIdempotencyKey,
  oneOffOccurrence,
  pendingNotifications,
  pruneOccurrences,
  recordNotificationIntent,
  recordOccurrence,
  recordOutcome,
  scheduleOccurrenceId,
  settleNotification,
  workEligibility,
} from "./work-producer-occurrences.js";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p4-occurrences-"));
  path = join(root, "schedules.db");
  setDb(new Database(path));
});
afterEach(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => closeDb());

/** Simulates a scheduler restart: the connection is dropped and the file reopened. */
function reopen(): void {
  closeDb();
  setDb(new Database(path));
}

function entry(overrides: Partial<BagSchedule> = {}, name = "nightly"): ScheduleEntry {
  return {
    id: `ops/${name}`,
    bag: "ops",
    name,
    dir: "/bags/ops",
    schedule: {
      trigger: { kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" },
      payload: { kind: "ref", ref: "ops:sweep" },
      identity: "ops",
      bags: ["maintenance"],
      bounds: ["local-only"],
      inputs: { depth: 2 },
      overlap: "skip",
      catchUp: "once",
      enabled: true,
      ...overrides,
    },
  };
}

const T0 = new Date("2026-10-15T10:00:00.000Z");
const SLOT = new Date("2026-10-15T05:30:00.000Z");

function slotOccurrence(e = entry(), slot = SLOT, generation: "legacy" | "work.v2" = "work.v2") {
  return newScheduleOccurrence({ entry: e, kind: "slot", discriminator: slot, policy: { late: false, coalesced_slots: 1 }, generation });
}

describe("occurrence identity", () => {
  it("is the nominal slot, in UTC, with the schedule's zone, context, payload and generation recorded", () => {
    const { occurrence, dispatch, created } = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    expect(created).toBe(true);
    expect(occurrence.occurrenceId).toBe("ops/nightly@2026-10-15T05:30:00.000Z");
    // The same spelling scheduleJobRun has always used for a job's key.
    expect(occurrence.idempotencyKey).toBe(occurrence.occurrenceId);
    expect(occurrence.slotAt?.toISOString()).toBe(SLOT.toISOString());
    expect(occurrence.timezone).toBe("America/New_York");
    expect(occurrence.context).toEqual({ identity: "ops", identity_id: null, traits: ["maintenance"], bounds: ["local-only"] });
    expect(occurrence.definition).toEqual({ kind: "action", reference: "ops:sweep", catalog_namespace: "ops" });
    expect(occurrence.inputs).toEqual({ depth: 2 });
    expect(occurrence.executorGeneration).toBe("work.v2");
    expect(occurrence.producerRef).toBe("schedules:ops/nightly");
    expect(dispatch.state).toBe("pending");
  });

  it("spells login and manual occurrences by their event and manual ids", () => {
    expect(scheduleOccurrenceId("ops/x", "login", "boot-1")).toBe("ops/x@login:boot-1");
    expect(scheduleOccurrenceId("ops/x", "manual", "retry-me")).toBe("ops/x@manual:retry-me");
  });

  it("digests a key over the 200-byte admission limit instead of truncating it", () => {
    const key = occurrenceIdempotencyKey(`ops/${"n".repeat(300)}@${SLOT.toISOString()}`);
    expect(key).toMatch(/^schedules:sha256:[a-f0-9]{64}$/);
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(200);
  });

  it("replays the same occurrence — same request id — and refuses a different payload under its id", () => {
    const first = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    const again = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: new Date(T0.getTime() + 5_000) });
    expect(again.created).toBe(false);
    expect(again.occurrence.requestId).toBe(first.occurrence.requestId);
    const edited = slotOccurrence(entry({ inputs: { depth: 3 } }));
    expect(() => recordOccurrence({ occurrence: edited, state: "pending", now: T0 })).toThrow(OccurrenceConflictError);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM work_producer_occurrence").get()).toEqual({ n: 1 });
  });

  it("keeps the original intent, and still advances the due time, when the scheduler re-derives a recorded slot differently", () => {
    const first = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    const next = new Date("2026-10-16T05:30:00.000Z");
    const again = recordOccurrence({ occurrence: slotOccurrence(entry({ inputs: { depth: 3 } })), state: "pending", statePatch: { next_fire_at: next }, onConflict: "keep-original", now: T0 });
    expect(again).toMatchObject({ created: false, occurrence: { inputs: { depth: 2 }, requestId: first.occurrence.requestId } });
    expect(getState("ops/nightly")?.next_fire_at?.toISOString()).toBe(next.toISOString());
  });

  it("is immutable in the store itself", () => {
    recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    expect(() => getDb().prepare("UPDATE work_producer_occurrence SET inputs_json = '{}'").run()).toThrow(/immutable/);
    expect(() => getDb().prepare("UPDATE work_producer_occurrence SET executor_generation = 'legacy'").run()).toThrow(/immutable/);
  });

  it("commits the occurrence and the due time it consumes together, and survives a reopen", () => {
    const next = new Date("2026-10-16T05:30:00.000Z");
    recordOccurrence({ occurrence: slotOccurrence(), state: "pending", statePatch: { next_fire_at: next, last_fired_at: T0 }, now: T0 });
    reopen();
    expect(getState("ops/nightly")?.next_fire_at?.toISOString()).toBe(next.toISOString());
    expect(dueOccurrences(T0, 10).map((o) => o.occurrenceId)).toEqual(["ops/nightly@2026-10-15T05:30:00.000Z"]);
  });

  it("rolls the due-time advance back with a failed occurrence write", () => {
    recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    const edited = slotOccurrence(entry({ inputs: { depth: 9 } }));
    expect(() => recordOccurrence({ occurrence: edited, state: "pending", statePatch: { next_fire_at: new Date("2030-01-01T00:00:00Z") }, now: T0 })).toThrow();
    expect(getState("ops/nightly")?.next_fire_at ?? null).toBeNull();
  });
});

describe("dispatch transitions", () => {
  const runner = { pid: 4242, startedAt: 1 };

  it("claims a pending occurrence once, binds authority once, and keeps accepted terminal", () => {
    const { occurrence } = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    expect(beginDispatch(occurrence.occurrenceId, runner, T0)?.attempts).toBe(1);
    expect(beginDispatch(occurrence.occurrenceId, runner, T0)).toBeNull();
    bindAuthority(occurrence.occurrenceId, { authorityRef: "agr_1", requestHash: "a".repeat(64) }, T0);
    bindAuthority(occurrence.occurrenceId, { authorityRef: "agr_1", requestHash: "a".repeat(64) }, T0);
    expect(() => bindAuthority(occurrence.occurrenceId, { authorityRef: "agr_2", requestHash: "a".repeat(64) }, T0)).toThrow(DispatchBindingError);
    markAccepted(occurrence.occurrenceId, { workId: "wrk_1", workflowId: "awf_1" }, T0);
    markAccepted(occurrence.occurrenceId, { workId: "wrk_1", workflowId: "awf_1" }, T0);
    expect(() => markAccepted(occurrence.occurrenceId, { workId: "wrk_2", workflowId: "awf_2" }, T0)).toThrow(DispatchBindingError);
    expect(() => getDb().prepare("UPDATE work_producer_dispatch SET state = 'pending'").run()).toThrow(/cannot be dispatched again/);
    markUnknown(occurrence.occurrenceId, { code: "late", message: "late" }, T0, T0);
    markRefused(occurrence.occurrenceId, { code: "late", message: "late" }, T0);
    expect(getOccurrence(occurrence.occurrenceId)?.dispatch.state).toBe("accepted");
    expect(beginDispatch(occurrence.occurrenceId, runner, new Date(T0.getTime() + 3_600_000))).toBeNull();
  });

  it("never rewinds a possibly admitted occurrence to pending", () => {
    const { occurrence } = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 });
    beginDispatch(occurrence.occurrenceId, runner, T0);
    expect(() => getDb().prepare("UPDATE work_producer_dispatch SET state = 'pending'").run()).toThrow(/cannot return to pending/);
    markUnknown(occurrence.occurrenceId, { code: "transport", message: "reply lost" }, new Date(T0.getTime() + 15_000), T0);
    expect(() => getDb().prepare("UPDATE work_producer_dispatch SET state = 'pending'").run()).toThrow(/cannot return to pending/);
    // Unknown is re-dispatchable only once its retry time comes — to observe, not to replace.
    expect(beginDispatch(occurrence.occurrenceId, runner, T0)).toBeNull();
    expect(beginDispatch(occurrence.occurrenceId, runner, new Date(T0.getTime() + 15_000))?.attempts).toBe(2);
  });

  it("lists another process's in-flight dispatches as abandoned, never its own", () => {
    const a = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 }).occurrence;
    const b = recordOccurrence({ occurrence: slotOccurrence(entry({}, "other")), state: "pending", now: T0 }).occurrence;
    beginDispatch(a.occurrenceId, { pid: 1, startedAt: 1 }, T0);
    beginDispatch(b.occurrenceId, runner, T0);
    reopen();
    expect(abandonedDispatches(runner).map((r) => r.occurrence.occurrenceId)).toEqual([a.occurrenceId]);
  });
});

describe("login occurrences", () => {
  it("commit the claim and the occurrence together: a claimed event is never lost or run twice", () => {
    const e = entry({ trigger: { kind: "login" } }, "at-login");
    const occurrence = newScheduleOccurrence({ entry: e, kind: "login", discriminator: "boot-7", policy: { late: false, coalesced_slots: 1, login_event_id: "boot-7" }, generation: "legacy" });
    expect(claimLoginOccurrence(occurrence, "boot-7", T0)?.created).toBe(true);
    reopen();
    expect(claimLoginOccurrence(occurrence, "boot-7", T0)).toBeNull();
    expect(dueOccurrences(T0, 10).map((o) => o.occurrenceId)).toEqual(["ops/at-login@login:boot-7"]);
    expect(getState("ops/at-login")?.last_fired_at?.toISOString()).toBe(T0.toISOString());
  });

  it("defers to a claim the legacy path already made", () => {
    getDb().prepare("INSERT INTO login_event_claims (schedule_id, event_id, claimed_at) VALUES ('ops/at-login', 'boot-8', ?)").run(T0.toISOString());
    const e = entry({ trigger: { kind: "login" } }, "at-login");
    const occurrence = newScheduleOccurrence({ entry: e, kind: "login", discriminator: "boot-8", policy: { late: false, coalesced_slots: 1 }, generation: "legacy" });
    expect(claimLoginOccurrence(occurrence, "boot-8", T0)).toBeNull();
    expect(dueOccurrences(T0, 10)).toEqual([]);
  });
});

describe("work eligibility", () => {
  it("keeps inline actions and unversioned jobs on the legacy generation, with the reason", () => {
    expect(workEligibility(entry())).toEqual({ eligible: true });
    expect(workEligibility(entry({ payload: { kind: "job", ref: "summarize" } }))).toEqual({ eligible: false, reason: "Work admits versioned jobs only" });
    expect(workEligibility(entry({ payload: { kind: "job", ref: "ops:summarize@2" } }))).toEqual({ eligible: true });
  });
});

describe("one-off adoption", () => {
  it("keys a one-off by its creator's key, and refuses what Work cannot carry", () => {
    const { schedule } = createAtSchedule({ bag: "ops", action: "ops:sweep", inputs: { a: 1 }, dueAt: T0, idempotencyKey: "check-later" }, T0);
    const occurrence = oneOffOccurrence(schedule, "work.v2");
    expect(occurrence.idempotencyKey).toBe("once:ops:check-later");
    expect(occurrence.oneOffId).toBe(schedule.id);
    const retrying = createAtSchedule({ bag: "ops", action: "ops:sweep", dueAt: T0, retryAttempts: 3 }, T0).schedule;
    expect(() => oneOffOccurrence(retrying, "work.v2")).toThrow(/retry budget/);
    const session = createAtSchedule({ bag: "ops", action: null, job: "ops:job@1", callerSessionId: "ses_1", dueAt: T0 }, T0).schedule;
    expect(() => oneOffOccurrence(session, "work.v2")).toThrow(/session/);
    expect(oneOffOccurrence(session, "legacy").definition).toEqual({ kind: "job", reference: "ops:job@1" });
    expect(getAtSchedule(schedule.id)?.status).toBe("pending");
  });
});

describe("notification intents", () => {
  it("group a failure streak into one notice, retry delivery without touching the work, and recover once", () => {
    const now = (s: number) => new Date(T0.getTime() + s * 1000);
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o1", outcome: "failed", summary: "boom 1", now: now(1) })?.transition).toBe("failure");
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o2", outcome: "failed", summary: "boom 2", now: now(2) })).toBeNull();
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o3", outcome: "failed", summary: "boom 3", now: now(3) })).toBeNull();
    const [failure] = pendingNotifications();
    expect(failure).toMatchObject({ transition: "failure", failures: 3, lastSummary: "boom 3", occurrenceId: "o1" });
    settleNotification(failure!.notificationKey, false, now(4));
    reopen();
    expect(pendingNotifications()).toHaveLength(1);
    settleNotification(failure!.notificationKey, true, now(5));
    settleNotification(failure!.notificationKey, true, now(6));
    expect(pendingNotifications()).toEqual([]);
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o4", outcome: "complete", summary: "ok", now: now(7) })?.transition).toBe("recovery");
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o5", outcome: "complete", summary: "ok", now: now(8) })).toBeNull();
    expect(getDb().prepare("SELECT attempts FROM work_producer_notification WHERE transition = 'failure'").get()).toEqual({ attempts: 2 });
  });

  it("drop an undelivered failure notice when the schedule recovers before anyone was told", () => {
    recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o1", outcome: "failed", summary: "boom", now: T0 });
    expect(recordNotificationIntent({ scheduleId: "ops/nightly", occurrenceId: "o2", outcome: "complete", summary: "ok", now: T0 })).toBeNull();
    expect(pendingNotifications()).toEqual([]);
  });
});

describe("retention", () => {
  it("prunes settled occurrences and keeps anything that may still await admission", () => {
    const runner = { pid: 4242, startedAt: 1 };
    const settled = recordOccurrence({ occurrence: slotOccurrence(), state: "pending", now: T0 }).occurrence;
    beginDispatch(settled.occurrenceId, runner, T0);
    markAccepted(settled.occurrenceId, { workId: "wrk_1", workflowId: null }, T0);
    recordOutcome(settled.occurrenceId, "complete", T0);
    const noOutcome = recordOccurrence({ occurrence: slotOccurrence(entry(), new Date("2026-10-14T05:30:00Z")), state: "pending", now: T0 }).occurrence;
    beginDispatch(noOutcome.occurrenceId, runner, T0);
    markAccepted(noOutcome.occurrenceId, { workId: "wrk_2", workflowId: null }, T0);
    const unknown = recordOccurrence({ occurrence: slotOccurrence(entry(), new Date("2026-10-13T05:30:00Z")), state: "pending", now: T0 }).occurrence;
    beginDispatch(unknown.occurrenceId, runner, T0);
    markUnknown(unknown.occurrenceId, { code: "x", message: "x" }, T0, T0);
    recordOccurrence({ occurrence: slotOccurrence(entry(), new Date("2026-10-12T05:30:00Z")), state: "pending", now: T0 });
    recordOccurrence({ occurrence: slotOccurrence(entry(), new Date("2026-10-11T05:30:00Z")), state: "missed", now: T0 });
    expect(pruneOccurrences(new Date("2027-01-01T00:00:00Z"))).toBe(2);
    const left = (getDb().prepare("SELECT occurrence_id FROM work_producer_occurrence ORDER BY occurrence_id").all() as Array<{ occurrence_id: string }>).map((r) => r.occurrence_id);
    expect(left).toEqual(["ops/nightly@2026-10-12T05:30:00.000Z", "ops/nightly@2026-10-13T05:30:00.000Z", "ops/nightly@2026-10-14T05:30:00.000Z"]);
  });
});
