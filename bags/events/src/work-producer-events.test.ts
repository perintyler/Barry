import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, setDb } from "./db.js";
import { setEventHookDispatcher } from "./hooks.js";
import { runBarryHook } from "./dispatch.js";
import { createEvent, createEventOnce, type EventRecord } from "./store.js";
import {
  EventOutboxDispatcher,
  eventCheckpoint,
  eventOutboxDispatchPort,
  getEventOccurrence,
  pruneEventOccurrences,
  recordEventOccurrences,
  type EventAdmissionPort,
  type EventOccurrence,
  type EventWorkSubscription,
} from "./work-producer-events.js";

let root: string;
let path: string;
const hookFirings: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p4-events-"));
  path = join(root, "events.db");
  setDb(new Database(path));
  hookFirings.length = 0;
  setEventHookDispatcher(async (payload) => {
    hookFirings.push(payload.id);
    return [];
  });
});
afterEach(() => {
  setEventHookDispatcher(null);
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

/** A consumer restart: the connection is dropped and the same file reopened. */
function reopen(): void {
  closeDb();
  setDb(new Database(path));
}

const T0 = new Date("2026-10-15T10:00:00.000Z");
const emit = (title: string, data: Record<string, unknown> = {}) => createEvent({ type: "session_ended", source: "sessions", title, data });

function reindex(overrides: Partial<EventWorkSubscription> = {}): EventWorkSubscription {
  return {
    consumer: "search:reindex",
    generation: "work.v2",
    intent: (event: EventRecord) =>
      event.type === "session_ended"
        ? { definition: { kind: "job", reference: "search:reindex@1" }, inputs: { session: event.data.session ?? null } }
        : null,
    ...overrides,
  };
}

const outboxRows = () => getDb().prepare("SELECT * FROM work_producer_event_outbox ORDER BY event_seq").all() as Array<{ occurrence_id: string; state: string; coalesced_count: number }>;

describe("source-key deduplication", () => {
  it("creates one event per source key, fires its hooks once, and replays the original", async () => {
    const first = await createEventOnce({ type: "session_ended", source: "watch-session", title: "ended" }, "watch:ses_1:ended");
    const again = await createEventOnce({ type: "session_ended", source: "watch-session", title: "ended (re-emitted after a crash)" }, "watch:ses_1:ended");
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, event: { id: first.event.id, title: "ended" } });
    expect(hookFirings).toEqual([first.event.id]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("survives a reopen", async () => {
    const first = await createEventOnce({ type: "x", source: "s", title: "t" }, "k1");
    reopen();
    expect((await createEventOnce({ type: "x", source: "s", title: "t" }, "k1")).event.id).toBe(first.event.id);
  });
});

describe("checkpointed occurrence recording", () => {
  it("starts a new consumer after the existing log, then records each new event once", async () => {
    await emit("before the consumer existed");
    expect(recordEventOccurrences(reindex(), { now: T0 })).toMatchObject({ scanned: 0, recorded: 0 });
    await emit("one", { session: "ses_1" });
    await emit("two", { session: "ses_2" });
    expect(recordEventOccurrences(reindex(), { now: T0 })).toMatchObject({ scanned: 2, recorded: 2 });
    expect(recordEventOccurrences(reindex(), { now: T0 })).toMatchObject({ scanned: 0, recorded: 0 });
    expect(outboxRows().map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  it("can start from the beginning, and walks the log in bounded batches", async () => {
    for (let i = 0; i < 5; i += 1) await emit(`e${i}`, { session: `ses_${i}` });
    const sub = reindex({ startAt: "beginning" });
    expect(recordEventOccurrences(sub, { now: T0, batch: 2 }).recorded).toBe(2);
    expect(recordEventOccurrences(sub, { now: T0, batch: 2 }).recorded).toBe(2);
    expect(recordEventOccurrences(sub, { now: T0, batch: 2 }).recorded).toBe(1);
    expect(recordEventOccurrences(sub, { now: T0, batch: 2 }).scanned).toBe(0);
    expect(outboxRows()).toHaveLength(5);
  });

  it("neither skips nor duplicates across a consumer restart", async () => {
    const sub = reindex({ startAt: "beginning" });
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(sub, { now: T0 });
    // The API dies after writing an event and before any hook ran (EV-1).
    await emit("b", { session: "ses_b" });
    reopen();
    expect(recordEventOccurrences(sub, { now: T0 })).toMatchObject({ scanned: 1, recorded: 1 });
    expect(outboxRows()).toHaveLength(2);
    expect(eventCheckpoint(sub.consumer)).toBe(2);
  });

  it("is idempotent when a checkpoint is behind its outbox (a replayed batch)", async () => {
    const sub = reindex({ startAt: "beginning" });
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(sub, { now: T0 });
    getDb().prepare("UPDATE work_producer_event_checkpoint SET last_seq = 0").run();
    expect(recordEventOccurrences(sub, { now: T0 })).toMatchObject({ scanned: 1, recorded: 0 });
    expect(outboxRows()).toHaveLength(1);
  });

  it("keys occurrences per consumer, so two consumers of one event are two occurrences", async () => {
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(reindex({ startAt: "beginning" }), { now: T0 });
    recordEventOccurrences(reindex({ startAt: "beginning", consumer: "memory:extract" }), { now: T0 });
    expect(outboxRows().map((r) => r.occurrence_id).sort()).toEqual([
      expect.stringMatching(/^events:memory:extract:evt_/),
      expect.stringMatching(/^events:search:reindex:evt_/),
    ]);
  });

  it("rolls the checkpoint back with a failing batch", async () => {
    await emit("a", { session: "ses_a" });
    const broken = reindex({ startAt: "beginning", intent: () => { throw new Error("subscription bug"); } });
    expect(() => recordEventOccurrences(broken, { now: T0 })).toThrow(/subscription bug/);
    expect(eventCheckpoint(broken.consumer)).toBeNull();
    expect(outboxRows()).toEqual([]);
  });
});

describe("bounded coalescing", () => {
  const coalescing = () => reindex({
    startAt: "beginning",
    coalesceMax: 3,
    intent: (event) => ({ definition: { kind: "job", reference: "search:reindex@1" }, inputs: { scope: event.data.scope ?? "all" }, coalesceKey: String(event.data.scope ?? "all") }),
  });

  it("folds same-key events into a pending occurrence up to the bound", async () => {
    for (let i = 0; i < 5; i += 1) await emit(`e${i}`, { scope: "docs" });
    await emit("other", { scope: "code" });
    recordEventOccurrences(coalescing(), { now: T0 });
    const rows = outboxRows();
    expect(rows.map((r) => r.coalesced_count)).toEqual([3, 2, 1]);
    expect(getEventOccurrence(rows[0]!.occurrence_id)!.coalescedEventIds).toHaveLength(2);
  });

  it("never folds into an occurrence that may already be admitted", async () => {
    await emit("a", { scope: "docs" });
    recordEventOccurrences(coalescing(), { now: T0 });
    const [row] = outboxRows();
    getDb().prepare("UPDATE work_producer_event_outbox SET state = 'dispatching' WHERE occurrence_id = ?").run(row!.occurrence_id);
    await emit("b", { scope: "docs" });
    recordEventOccurrences(coalescing(), { now: T0 });
    expect(outboxRows().map((r) => r.coalesced_count)).toEqual([1, 1]);
    expect(() => getDb().prepare("UPDATE work_producer_event_outbox SET coalesced_count = 9 WHERE occurrence_id = ?").run(row!.occurrence_id)).toThrow(/pending/);
  });
});

describe("outbox invariants", () => {
  it("keeps what an occurrence will be submitted as immutable, and accepted terminal", async () => {
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(reindex({ startAt: "beginning" }), { now: T0 });
    const [row] = outboxRows();
    expect(() => getDb().prepare("UPDATE work_producer_event_outbox SET inputs_json = '{}'").run()).toThrow(/immutable/);
    expect(() => getDb().prepare("UPDATE work_producer_event_outbox SET idempotency_key = 'new'").run()).toThrow(/immutable/);
    const port = eventOutboxDispatchPort(() => T0);
    getDb().prepare("UPDATE work_producer_event_outbox SET state = 'dispatching'").run();
    expect(() => getDb().prepare("UPDATE work_producer_event_outbox SET state = 'pending'").run()).toThrow(/cannot return to pending/);
    port.markAccepted(row!.occurrence_id, { workId: "wrk_1", workflowId: "awf_1" });
    expect(() => port.markAccepted(row!.occurrence_id, { workId: "wrk_2", workflowId: null })).toThrow(/already accepted/);
    port.markUnknown(row!.occurrence_id, { code: "late", message: "late" }, T0);
    expect(getEventOccurrence(row!.occurrence_id)!.state).toBe("accepted");
  });
});

describe("dispatch", () => {
  it("delivers a work.v2 occurrence with its stored key and request id, and observes it after a lost reply", async () => {
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(reindex({ startAt: "beginning" }), { now: T0 });
    const [row] = outboxRows();
    const stored = getEventOccurrence(row!.occurrence_id)!;
    let clock = T0;
    const seen: Array<{ key: string; requestId: string; possiblyAdmitted: boolean; trigger: string }> = [];
    const port = eventOutboxDispatchPort(() => clock);
    // Structurally the shared WorkProducerAdmission; its decisions are tested
    // against the real issuer/verifier in bags/schedules.
    const admission: EventAdmissionPort = {
      async admit(occurrence) {
        seen.push({ key: occurrence.submission.idempotency_key, requestId: occurrence.submission.request_id, possiblyAdmitted: occurrence.possiblyAdmitted, trigger: occurrence.submission.origin.trigger });
        if (!occurrence.possiblyAdmitted) {
          const retryAt = new Date(clock.getTime() + 15_000);
          port.markUnknown(occurrence.occurrenceId, { code: "transport", message: "reply lost" }, retryAt);
          return { state: "unknown", code: "transport", message: "reply lost", retryAt };
        }
        port.markAccepted(occurrence.occurrenceId, { workId: "wrk_1", workflowId: "awf_1" });
        return { state: "accepted", workId: "wrk_1", workflowId: "awf_1", recovered: true };
      },
    };
    const dispatcher = new EventOutboxDispatcher({ admission, legacy: null, runner: { pid: 7, startedAt: 1 }, probe: () => "gone", now: () => clock });
    expect(await dispatcher.dispatch(stored.occurrenceId)).toMatchObject({ kind: "unknown" });
    expect(await dispatcher.dispatch(stored.occurrenceId)).toMatchObject({ kind: "skipped", state: "unknown" });
    clock = new Date(T0.getTime() + 15_000);
    reopen();
    expect(dispatcher.due().map((o) => o.occurrenceId)).toEqual([stored.occurrenceId]);
    expect(await dispatcher.dispatch(stored.occurrenceId)).toMatchObject({ kind: "accepted", workId: "wrk_1", recovered: true });
    expect(seen).toEqual([
      { key: stored.idempotencyKey, requestId: stored.requestId, possiblyAdmitted: false, trigger: "event" },
      { key: stored.idempotencyKey, requestId: stored.requestId, possiblyAdmitted: true, trigger: "event" },
    ]);
    expect(await dispatcher.dispatch(stored.occurrenceId)).toMatchObject({ kind: "skipped", state: "accepted" });
  });

  it("runs a legacy occurrence once, and never again when its dispatcher died mid-run", async () => {
    for (const s of ["ses_a", "ses_b"]) await emit(s, { session: s });
    recordEventOccurrences(reindex({ startAt: "beginning", generation: "legacy" }), { now: T0 });
    const [a, b] = outboxRows();
    const runs: string[] = [];
    const legacy = async (occurrence: EventOccurrence) => {
      runs.push(occurrence.occurrenceId);
      return { ok: true };
    };
    const first = new EventOutboxDispatcher({ admission: null, legacy, runner: { pid: 7, startedAt: 1 }, probe: () => "gone", now: () => T0 });
    expect(await first.dispatch(a!.occurrence_id)).toEqual({ kind: "ran", ok: true });
    // b is claimed by a dispatcher that then dies before recording anything.
    getDb().prepare("UPDATE work_producer_event_outbox SET state = 'dispatching', dispatcher_pid = 99, attempts = 1 WHERE occurrence_id = ?").run(b!.occurrence_id);
    reopen();
    const second = new EventOutboxDispatcher({ admission: null, legacy, runner: { pid: 8, startedAt: 1 }, probe: () => "gone", now: () => T0 });
    expect(second.recoverAbandoned()).toEqual([{ occurrenceId: b!.occurrence_id, action: "needs-attention" }]);
    expect(second.due()).toEqual([]);
    expect(await second.dispatch(b!.occurrence_id)).toEqual({ kind: "skipped", state: "unknown" });
    expect(await second.dispatch(a!.occurrence_id)).toEqual({ kind: "skipped", state: "accepted" });
    expect(runs).toEqual([a!.occurrence_id]);
    expect(getEventOccurrence(b!.occurrence_id)).toMatchObject({ state: "unknown", lastErrorCode: "legacy_outcome_unknown" });
  });

  it("leaves a live dispatcher's claim alone", async () => {
    await emit("a", { session: "ses_a" });
    recordEventOccurrences(reindex({ startAt: "beginning" }), { now: T0 });
    getDb().prepare("UPDATE work_producer_event_outbox SET state = 'dispatching', dispatcher_pid = 99").run();
    const d = new EventOutboxDispatcher({ admission: null, legacy: null, runner: { pid: 8, startedAt: 1 }, probe: () => "unknown", now: () => T0 });
    expect(d.recoverAbandoned()).toMatchObject([{ action: "left-alive" }]);
    expect(outboxRows()[0]!.state).toBe("dispatching");
  });

  it("prunes settled occurrences and keeps unresolved ones", async () => {
    for (const s of ["a", "b", "c"]) await emit(s, { session: s });
    recordEventOccurrences(reindex({ startAt: "beginning" }), { now: T0 });
    const [a, b] = outboxRows();
    const port = eventOutboxDispatchPort(() => T0);
    getDb().prepare("UPDATE work_producer_event_outbox SET state = 'dispatching' WHERE occurrence_id IN (?, ?)").run(a!.occurrence_id, b!.occurrence_id);
    port.markAccepted(a!.occurrence_id, { workId: "wrk_1", workflowId: null });
    port.markUnknown(b!.occurrence_id, { code: "x", message: "x" }, T0);
    expect(pruneEventOccurrences(new Date("2030-01-01T00:00:00Z"))).toBe(1);
    expect(outboxRows().map((r) => r.state)).toEqual(["unknown", "pending"]);
    expect(eventCheckpoint("search:reindex")).toBe(3);
  });
});

describe("legacy hook runner environment", () => {
  let registryPath: string;
  beforeEach(() => {
    registryPath = join(root, "bags.snapshot.json");
    process.env.BARRY_BAGS_SNAPSHOT = registryPath;
  });
  afterEach(() => {
    delete process.env.BARRY_BAGS_SNAPSHOT;
  });

  function hookBag(name: string, out: string): void {
    const dir = join(root, name);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "on-event.mjs"), [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ secret: process.env.BARRY_SECRET ?? null, marker: process.env.P4_SCOPED ?? null }));`,
    ].join("\n"));
    writeFileSync(join(dir, "bag.yaml"), [`name: ${name}`, `description: test bag`, `hooks:`, `  barry:`, `    - event: event-created`, `      run: hooks/on-event.mjs`, ``].join("\n"));
    const snapshot = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, "utf8")) as { bags: Record<string, unknown> }) : { bags: {} };
    snapshot.bags[name] = { type: "local", path: dir };
    writeFileSync(registryPath, JSON.stringify(snapshot));
  }

  it("runs only the named bag's hook, with the scoped environment instead of this process's", async () => {
    const out = join(root, "env.json");
    const other = join(root, "other.json");
    hookBag("alerts", out);
    hookBag("unrelated", other);
    const previous = process.env.BARRY_SECRET;
    process.env.BARRY_SECRET = "api-secret-that-must-not-leak";
    try {
      const outcomes = await runBarryHook("alerts", { event: "event-created", id: "evt_1", record: {} }, { PATH: process.env.PATH ?? "", P4_SCOPED: "yes" });
      expect(outcomes).toMatchObject([{ bag: "alerts", ok: true }]);
    } finally {
      if (previous === undefined) delete process.env.BARRY_SECRET;
      else process.env.BARRY_SECRET = previous;
    }
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ secret: null, marker: "yes" });
    expect(existsSync(other)).toBe(false);
    expect(await runBarryHook("missing", { event: "event-created", id: "evt_1", record: {} }, {})).toMatchObject([{ ok: false }]);
  });
});
