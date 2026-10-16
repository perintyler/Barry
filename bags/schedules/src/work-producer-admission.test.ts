/**
 * P4 producer admission, end to end inside the producer: the real Scheduler,
 * occurrence ledger, dispatcher and WorkProducerAdmission, submitting through
 * the SDK's real WorkDelegationIssuer and WorkDelegationVerifier and the real
 * intent hash. The owner side is a SQLite fixture that deduplicates by
 * (namespace, key) the way WorkAdmissionService does; a composed
 * WorkflowOwner is a main-owned integration gate, not exercised here.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { BagSchedule } from "@barry-rocks/sdk/internal/schedules";
import { approveWorkflowBounds, boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import {
  WorkDelegationIssuer,
  WorkDelegationVerifier,
  workIntentHash,
  type DelegationKey,
  type WorkAuthority,
} from "@barry-rocks/sdk/internal/workflows";
import { closeDb, getDb, setDb } from "./db.js";
import { getState } from "./store.js";
import type { ScheduleEntry } from "./registry.js";
import { Scheduler, type FireOutcome, type SchedulerDeps, type Transition } from "./scheduler.js";
import { createAtSchedule, getAtSchedule, type AtSchedule } from "./at-schedules.js";
import { nextFireAfter } from "./next-fire.js";
import { probeProcess } from "./process.js";
import {
  WorkProducerAdmission,
  type WorkProducerAcceptance,
  type WorkProducerAuthorityPort,
  type WorkProducerTransport,
} from "./work-producer-admission.js";
import { ScheduleOccurrenceDispatcher, ledgerDispatchPort, type LegacyOccurrenceRunners } from "./work-producer-dispatcher.js";
import {
  beginDispatch,
  getOccurrence,
  listOccurrences,
  newScheduleOccurrence,
  pendingNotifications,
  recordOccurrence,
  type ExecutorGeneration,
  type ProducerOccurrence,
} from "./work-producer-occurrences.js";

const INSTALLATION = "owner-installation";
const ISSUER = "schedules.scheduler";
const cleanup: Array<() => void> = [];
let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p4-admission-"));
  dbPath = join(root, "schedules.db");
  setDb(new Database(dbPath));
});
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => closeDb());

/** A scheduler restart: the connection is dropped and the same file reopened. */
function reopen(): void {
  closeDb();
  setDb(new Database(dbPath));
}

function entry(overrides: Partial<BagSchedule> = {}, name = "sweep"): ScheduleEntry {
  return {
    id: `ops/${name}`,
    bag: "ops",
    name,
    dir: "/bags/ops",
    schedule: {
      trigger: { kind: "cron", expression: "*/5 * * * *", timezone: "UTC" },
      payload: { kind: "ref", ref: "ops:sweep" },
      identity: "ops",
      bags: ["maintenance"],
      inputs: { depth: 2 },
      overlap: "skip",
      catchUp: "once",
      enabled: true,
      ...overrides,
    },
  };
}

const scriptAction: ActionMeta = {
  source: "bag",
  name: "sweep",
  bag: "ops",
  qualifiedName: "ops:sweep",
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

/** The owner side: real delegation verification and intent hashing over a key-deduplicating store. */
async function ownerFixture() {
  const now = Date.now();
  const key: DelegationKey = { id: "schedules-key-1", secret: "fixture-only-schedule-delegation-key-0000000", not_before: now - 60_000, not_after: now + 3_600_000 };
  const ceiling = await approveWorkflowBounds({
    identity: "ops",
    bags: ["maintenance"],
    traitNames: ["maintenance"],
    traits: { maintenance: { namespaces: ["documents"], access: "read" } },
    tools: [{ namespace: "documents", toolName: "read", access: "read" }],
    boundByName: async () => undefined,
  });
  const anonymousCeiling = await approveWorkflowBounds({
    bags: ["maintenance"],
    traitNames: ["maintenance"],
    traits: { maintenance: { namespaces: ["documents"], access: "read" } },
    tools: [{ namespace: "documents", toolName: "read", access: "read" }],
    boundByName: async () => undefined,
  });
  const issuer = new WorkDelegationIssuer({ path: join(root, "issuer.db"), issuer: ISSUER, signingKey: () => key });
  cleanup.push(() => issuer.close());
  let currentPolicy: ApprovedBounds = ceiling;
  const verifier = new WorkDelegationVerifier({
    installation: INSTALLATION,
    keys: (name) => (name === ISSUER ? [key] : []),
    authorizeIssuer: (record) =>
      record.issuer === ISSUER &&
      record.source_kind === "schedule" &&
      record.authority.namespace.principal_kind === "service" &&
      record.authority.namespace.principal_id === ISSUER &&
      record.authority.namespace.caller_session_id === null &&
      record.authority.origin.trigger === "schedule" &&
      record.authority.origin.entry_point === ISSUER &&
      Boolean(record.authority.origin.occurrence_id) &&
      Boolean(record.authority.origin.producer_ref),
    currentPolicy: async (record) => (record.authority.run_identity === null ? anonymousCeiling : currentPolicy),
  });
  const store = new Database(join(root, "owner.db"));
  cleanup.push(() => store.close());
  store.exec(`CREATE TABLE admissions (namespace_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    work_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (namespace_hash, idempotency_key))`);
  const faults = { failBeforeCommit: 0, dropReplyAfterCommit: 0, hangAfterCommit: 0, lookupFails: 0 };
  const calls = { submits: 0, lookups: 0, requestIds: [] as string[] };
  const verified: WorkAuthority[] = [];

  const acceptance = (row: { work_id: string; record: string; request_hash: string; idempotency_key: string }): WorkProducerAcceptance => {
    const record = JSON.parse(row.record) as { origin: WorkProducerAcceptance["origin"]; namespace: WorkProducerAcceptance["namespace"] };
    return { work_id: row.work_id, workflow_id: `awf_${row.work_id}`, idempotency_key: row.idempotency_key, request_hash: row.request_hash, origin: record.origin, namespace: record.namespace };
  };
  const transport: WorkProducerTransport = {
    async submit({ request, delegation }) {
      calls.submits += 1;
      calls.requestIds.push(request.request_id);
      if (faults.failBeforeCommit > 0) {
        faults.failBeforeCommit -= 1;
        throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
      }
      const authority = await verifier.authenticate(request, delegation, "admit");
      verified.push(authority);
      const hash = workIntentHash(request, authority.namespace);
      const namespaceHash = boundFingerprint(authority.namespace);
      const existing = store.prepare("SELECT * FROM admissions WHERE namespace_hash = ? AND idempotency_key = ?").get(namespaceHash, request.idempotency_key) as
        | { work_id: string; record: string; request_hash: string; idempotency_key: string }
        | undefined;
      if (existing && existing.request_hash !== hash) throw Object.assign(new Error("This key already identifies different work."), { status: 409, code: "IdempotencyConflict", retryable: false });
      if (!existing) {
        const count = (store.prepare("SELECT COUNT(*) AS n FROM admissions").get() as { n: number }).n;
        store.prepare("INSERT INTO admissions VALUES (?, ?, ?, ?, ?, ?)").run(
          namespaceHash, request.idempotency_key, hash, `wrk_${count + 1}`, request.request_id,
          JSON.stringify({ origin: authority.origin, namespace: authority.namespace, run_identity: authority.run_identity, traits: authority.caller_ceiling.traits }),
        );
      }
      const row = store.prepare("SELECT * FROM admissions WHERE namespace_hash = ? AND idempotency_key = ?").get(namespaceHash, request.idempotency_key) as {
        work_id: string; record: string; request_hash: string; idempotency_key: string;
      };
      if (faults.hangAfterCommit > 0) {
        faults.hangAfterCommit -= 1;
        return new Promise<WorkProducerAcceptance>(() => {});
      }
      if (faults.dropReplyAfterCommit > 0) {
        faults.dropReplyAfterCommit -= 1;
        throw new Error("socket hang up");
      }
      return acceptance(row);
    },
    async lookup(idempotencyKey) {
      calls.lookups += 1;
      if (faults.lookupFails > 0) {
        faults.lookupFails -= 1;
        throw Object.assign(new Error("owner unavailable"), { status: 503, code: "StoreUnavailable", retryable: true });
      }
      const row = store.prepare("SELECT * FROM admissions WHERE idempotency_key = ?").get(idempotencyKey) as
        | { work_id: string; record: string; request_hash: string; idempotency_key: string }
        | undefined;
      return row ? acceptance(row) : null;
    },
  };

  /** The main-owned composition, as a fixture: a service principal for exactly the occurrence asked about. */
  const authorityPort = (override?: (authority: WorkAuthority) => WorkAuthority): WorkProducerAuthorityPort => ({
    sourceKind: "schedule",
    async authenticate(origin, selection) {
      const authority: WorkAuthority = {
        namespace: { installation: INSTALLATION, principal_kind: "service", principal_id: ISSUER, identity_id: selection.identity ? "identity-uuid-ops" : null, caller_session_id: null },
        caller_ceiling: selection.identity ? ceiling : anonymousCeiling,
        origin,
        run_identity: selection.identity,
      };
      return override ? override(authority) : authority;
    },
  });
  const admissions = () => store.prepare("SELECT * FROM admissions ORDER BY work_id").all() as Array<{ idempotency_key: string; work_id: string; request_id: string; record: string }>;
  return { issuer, transport, authorityPort, faults, calls, verified, admissions, store, setPolicy: (scope: ApprovedBounds) => { currentPolicy = scope; }, ceiling };
}

type Owner = Awaited<ReturnType<typeof ownerFixture>>;

/** The scheduler process: clock, legacy runners that count effects, and the durable ledger. */
function processFixture(owner: Owner | null, options: {
  entries: ScheduleEntry[];
  pid?: number;
  generation?: ExecutorGeneration | ((e: ScheduleEntry) => ExecutorGeneration);
  clock: { now: Date };
  authority?: WorkProducerAuthorityPort;
  probe?: (pid: number, startedAt: number | null) => "alive" | "gone" | "unknown";
  holdActions?: boolean;
  actionFails?: boolean;
  announceWorks?: boolean;
  jobAcceptCrashes?: number;
}) {
  const effects: string[] = [];
  const announced: Array<{ id: string; transition: Transition; summary: string }> = [];
  const held: Array<() => void> = [];
  let jobAcceptCrashes = options.jobAcceptCrashes ?? 0;
  const runner = { pid: options.pid ?? 5000, startedAt: 1 };
  const now = () => options.clock.now;
  const legacy: LegacyOccurrenceRunners = {
    async acceptJob(e, occurrence: ProducerOccurrence) {
      const { schedule } = createAtSchedule({ bag: e.bag, action: null, job: occurrence.definition.kind === "job" ? occurrence.definition.reference : "ops:job", dueAt: occurrence.slotAt ?? occurrence.createdAt, idempotencyKey: occurrence.idempotencyKey, createdBy: "schedule" }, occurrence.slotAt ?? occurrence.createdAt);
      if (jobAcceptCrashes > 0) {
        jobAcceptCrashes -= 1;
        throw new Error("scheduler died after createAtSchedule committed");
      }
      return schedule;
    },
    async awaitJob(schedule: AtSchedule) {
      effects.push(`job:${schedule.id}`);
      return { status: "complete", runId: schedule.id, summary: "job ok" };
    },
    findJobOneOff(occurrence) {
      const row = getDb().prepare("SELECT id FROM one_off WHERE idempotency_key = ?").get(occurrence.idempotencyKey) as { id: string } | undefined;
      return row ? getAtSchedule(row.id) : null;
    },
    async runAction(e) {
      effects.push(`action:${e.id}`);
      if (options.holdActions) await new Promise<void>((resolve) => held.push(resolve));
      return options.actionFails ? { status: "failed", runId: null, summary: "exited 1" } : { status: "complete", runId: `arn_${effects.length}`, summary: "ok" };
    },
  };
  const admission = owner
    ? new WorkProducerAdmission({ authority: options.authority ?? owner.authorityPort(), issuer: owner.issuer, transport: owner.transport, store: ledgerDispatchPort(now), now })
    : null;
  const dispatcher = new ScheduleOccurrenceDispatcher({ admission, legacy, runner, probe: options.probe ?? (() => "gone"), now });
  const generation = options.generation ?? "work.v2";
  const unused = async (): Promise<FireOutcome> => {
    throw new Error("the durable path must not call the direct runners");
  };
  const deps: SchedulerDeps = {
    listSchedules: async () => ({ schedules: options.entries, errors: [] }),
    resolveAction: async () => scriptAction,
    runScript: unused,
    runAgent: unused,
    runJob: unused,
    announce: async (e, transition, outcome) => {
      if (options.announceWorks === false) return false;
      announced.push({ id: e.id, transition, summary: outcome.summary });
      return true;
    },
    runAtSchedule: async () => ({ outcome: "succeeded", exitCode: 0, runId: null }),
    recoverAtSchedules: () => {},
    runner,
    loginEventId: () => "login-1",
    now,
    occurrences: { dispatcher, generation: typeof generation === "function" ? generation : () => generation },
  };
  const scheduler = new Scheduler(deps);
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.all(scheduler.running);
  };
  const tick = async () => {
    await scheduler.tick();
    await settle();
  };
  return { scheduler, tick, settle, effects, announced, release: () => held.splice(0).forEach((r) => r()), dispatcher, runner };
}

const at = (iso: string) => new Date(iso);
const advance = (clock: { now: Date }, ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

describe("durable schedule occurrences through canonical Work admission", () => {
  it("records each slot once and admits it once across repeated ticks and a restart", async () => {
    const owner = await ownerFixture();
    const clock = { now: at("2026-10-15T10:01:00Z") };
    let p = processFixture(owner, { entries: [entry()], clock });
    await p.tick(); // first sight: next slot is 10:05
    clock.now = at("2026-10-15T10:05:01Z");
    await p.tick();
    await p.tick();
    reopen();
    p = processFixture(owner, { entries: [entry()], clock, pid: 5001 });
    await p.tick();
    const occurrences = listOccurrences("ops/sweep");
    expect(occurrences.map((o) => o.occurrence.occurrenceId)).toEqual(["ops/sweep@2026-10-15T10:05:00.000Z"]);
    expect(occurrences[0]!.dispatch).toMatchObject({ state: "accepted", workId: "wrk_1", attempts: 1 });
    expect(owner.admissions()).toHaveLength(1);
    expect(owner.calls.submits).toBe(1);
    expect(getState("ops/sweep")).toMatchObject({ last_status: "accepted", last_run_id: "wrk_1" });
    expect(getState("ops/sweep")?.next_fire_at?.toISOString()).toBe("2026-10-15T10:10:00.000Z");
  });

  it("preserves the schedule's identity and selected traits in the verified authority", async () => {
    const owner = await ownerFixture();
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(owner, { entries: [entry()], clock });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    expect(owner.verified).toHaveLength(1);
    const [authority] = owner.verified;
    expect(authority!.namespace).toEqual({ installation: INSTALLATION, principal_kind: "service", principal_id: ISSUER, identity_id: "identity-uuid-ops", caller_session_id: null });
    expect(authority!.run_identity).toBe("ops");
    expect(authority!.caller_ceiling.traits).toContain("maintenance");
    expect(authority!.origin).toEqual({ entry_point: "schedules.scheduler", trigger: "schedule", occurrence_id: "ops/sweep@2026-10-15T10:05:00.000Z", producer_ref: "schedules:ops/sweep" });
  });

  it("recovers a lost reply by looking the original key up: one admission, no resubmission", async () => {
    const owner = await ownerFixture();
    owner.faults.dropReplyAfterCommit = 1;
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(owner, { entries: [entry()], clock });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "unknown", lastErrorCode: "transport" });
    expect(getState("ops/sweep")?.last_status).toBe("unknown");
    advance(clock, 15_000);
    await p.tick();
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "accepted", workId: "wrk_1" });
    expect(owner.calls).toMatchObject({ submits: 1, lookups: 1 });
    expect(owner.admissions()).toHaveLength(1);
    expect(getState("ops/sweep")?.last_summary).toContain("recovered by key");
  });

  it("redelivers the identical submission when the key is not found, and the owner deduplicates it", async () => {
    const owner = await ownerFixture();
    owner.faults.failBeforeCommit = 1;
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(owner, { entries: [entry()], clock });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    advance(clock, 15_000);
    await p.tick();
    expect(owner.calls.submits).toBe(2);
    expect(new Set(owner.calls.requestIds).size).toBe(1);
    expect(owner.admissions()).toHaveLength(1);
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(owner.admissions()[0]).toMatchObject({ idempotency_key: id, request_id: getOccurrence(id)!.occurrence.requestId });
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "accepted", attempts: 2 });
  });

  it("keeps an accepted key unknown while it cannot be observed, without minting a new key or resubmitting", async () => {
    const owner = await ownerFixture();
    owner.faults.dropReplyAfterCommit = 1;
    owner.faults.lookupFails = 2;
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(owner, { entries: [entry()], clock });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    advance(clock, 15_000);
    await p.tick();
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "unknown", lastErrorCode: "lookup:StoreUnavailable" });
    advance(clock, 30_000);
    await p.tick();
    expect(getOccurrence(id)?.dispatch.state).toBe("unknown");
    expect(owner.calls.submits).toBe(1);
    advance(clock, 60_000);
    await p.tick();
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "accepted", workId: "wrk_1" });
    expect(owner.calls.submits).toBe(1);
    expect(owner.admissions()).toHaveLength(1);
  });

  it("recovers an admission a restarted scheduler left mid-flight, by key, without a second admission", async () => {
    const owner = await ownerFixture();
    owner.faults.hangAfterCommit = 1;
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const first = processFixture(owner, { entries: [entry()], clock, pid: 5000 });
    await first.scheduler.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    void first.scheduler.tick(); // the submission commits and its reply never comes: the process "dies"
    await new Promise((resolve) => setTimeout(resolve, 50));
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(getOccurrence(id)?.dispatch.state).toBe("dispatching");
    reopen();
    advance(clock, 1_000);
    const second = processFixture(owner, { entries: [entry()], clock, pid: 5001, probe: () => "gone" });
    await second.tick();
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "accepted", workId: "wrk_1" });
    expect(owner.admissions()).toHaveLength(1);
    expect(owner.calls.submits).toBe(1);
  });

  it("leaves another live scheduler's in-flight dispatch alone", async () => {
    const owner = await ownerFixture();
    const clock = { now: at("2026-10-15T10:05:00Z") };
    const e = entry();
    const { occurrence } = recordOccurrence({ occurrence: newScheduleOccurrence({ entry: e, kind: "slot", discriminator: at("2026-10-15T10:05:00Z"), policy: { late: false, coalesced_slots: 1 }, generation: "work.v2" }), state: "pending", now: clock.now });
    beginDispatch(occurrence.occurrenceId, { pid: 4000, startedAt: 1 }, clock.now);
    const p = processFixture(owner, { entries: [e], clock, pid: 5001, probe: () => "alive" });
    expect(p.dispatcher.recoverAbandoned()).toEqual([{ occurrenceId: occurrence.occurrenceId, action: "left-alive" }]);
    const unknown = processFixture(owner, { entries: [e], clock, pid: 5001, probe: () => "unknown" });
    expect(unknown.dispatcher.recoverAbandoned()).toEqual([{ occurrenceId: occurrence.occurrenceId, action: "left-alive" }]);
    expect(getOccurrence(occurrence.occurrenceId)?.dispatch.state).toBe("dispatching");
    expect(owner.calls.submits).toBe(0);
  });

  it("refuses a key the owner holds for different intent, and never tries a new key", async () => {
    const owner = await ownerFixture();
    owner.store.prepare("INSERT INTO admissions VALUES (?, ?, ?, ?, ?, ?)").run(
      boundFingerprint({ installation: INSTALLATION, principal_kind: "service", principal_id: ISSUER, identity_id: "identity-uuid-ops", caller_session_id: null }),
      "ops/sweep@2026-10-15T10:05:00.000Z", "f".repeat(64), "wrk_other", "00000000-0000-4000-8000-000000000000", JSON.stringify({ origin: {}, namespace: {} }),
    );
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(owner, { entries: [entry()], clock });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    advance(clock, 60_000); // before the next slot: only the refused occurrence could be retried, and it is not
    await p.tick();
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(getOccurrence(id)?.dispatch).toMatchObject({ state: "refused", lastErrorCode: "IdempotencyConflict" });
    expect(owner.calls.submits).toBe(1);
    expect(getState("ops/sweep")).toMatchObject({ last_status: "failed", consecutive_failures: 1 });
  });

  describe("authority is never broadened or substituted", () => {
    const cases: Array<[string, (a: WorkAuthority) => WorkAuthority, RegExp]> = [
      ["an operator principal for a schedule occurrence", (a) => ({ ...a, namespace: { ...a.namespace, principal_kind: "operator", principal_id: "local-operator", identity_id: null }, run_identity: null }), /service principal|identity was dropped/],
      ["a dropped identity", (a) => ({ ...a, namespace: { ...a.namespace, identity_id: null }, run_identity: null }), /identity was dropped/],
      ["a different origin", (a) => ({ ...a, origin: { ...a.origin, occurrence_id: "ops/sweep@another" } }), /different origin/],
      ["a caller session", (a) => ({ ...a, namespace: { ...a.namespace, caller_session_id: "ses_1" } }), /caller session/],
    ];
    for (const [name, override, message] of cases) {
      it(`refuses ${name} before anything reaches the owner`, async () => {
        const owner = await ownerFixture();
        const clock = { now: at("2026-10-15T10:04:59Z") };
        const p = processFixture(owner, { entries: [entry()], clock, authority: owner.authorityPort(override) });
        await p.tick();
        clock.now = at("2026-10-15T10:05:00Z");
        await p.tick();
        const dispatch = getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!.dispatch;
        expect(dispatch).toMatchObject({ state: "refused", lastErrorCode: "AuthorityMismatch" });
        expect(dispatch.lastError).toMatch(message);
        expect(owner.calls.submits).toBe(0);
      });
    }

    it("refuses a ceiling that silently dropped a selected trait", async () => {
      const owner = await ownerFixture();
      const bare = await approveWorkflowBounds({ identity: "ops", bags: [], tools: [], boundByName: async () => undefined });
      const clock = { now: at("2026-10-15T10:04:59Z") };
      const p = processFixture(owner, { entries: [entry()], clock, authority: owner.authorityPort((a) => ({ ...a, caller_ceiling: bare })) });
      await p.tick();
      clock.now = at("2026-10-15T10:05:00Z");
      await p.tick();
      expect(getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!.dispatch.lastError).toMatch(/maintenance/);
      expect(owner.calls.submits).toBe(0);
    });

    it("refuses to run an identity-free schedule as someone", async () => {
      const owner = await ownerFixture();
      const e = entry({ identity: undefined });
      const clock = { now: at("2026-10-15T10:04:59Z") };
      const p = processFixture(owner, { entries: [e], clock, authority: owner.authorityPort((a) => ({ ...a, namespace: { ...a.namespace, identity_id: "identity-uuid-ops" }, run_identity: "ops", caller_ceiling: owner.ceiling })) });
      await p.tick();
      clock.now = at("2026-10-15T10:05:00Z");
      await p.tick();
      expect(getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!.dispatch.lastError).toMatch(/identity-free/);
      expect(owner.calls.submits).toBe(0);
    });

    it("admits an identity-free schedule as identity-free with its explicit traits", async () => {
      const owner = await ownerFixture();
      const clock = { now: at("2026-10-15T10:04:59Z") };
      const p = processFixture(owner, { entries: [entry({ identity: undefined })], clock });
      await p.tick();
      clock.now = at("2026-10-15T10:05:00Z");
      await p.tick();
      expect(owner.verified[0]).toMatchObject({ run_identity: null, namespace: { identity_id: null, principal_kind: "service" } });
      expect(owner.verified[0]!.caller_ceiling.traits).toContain("maintenance");
    });
  });

  it("keeps a recorded occurrence on its generation: legacy stays legacy, work waits for an admission adapter", async () => {
    const owner = await ownerFixture();
    const clock = { now: at("2026-10-15T10:04:59Z") };
    // Recorded on the legacy generation, then the composition changes its mind.
    let generation: ExecutorGeneration = "legacy";
    const legacyFirst = processFixture(null, { entries: [entry()], clock, generation: () => generation, holdActions: true });
    await legacyFirst.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await legacyFirst.scheduler.tick();
    generation = "work.v2";
    legacyFirst.release();
    await legacyFirst.settle();
    expect(getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!.occurrence.executorGeneration).toBe("legacy");
    expect(legacyFirst.effects).toEqual(["action:ops/sweep"]);
    // A work.v2 occurrence recorded while no adapter is composed waits, visibly.
    clock.now = at("2026-10-15T10:10:00Z");
    const noAdapter = processFixture(null, { entries: [entry()], clock, generation: "work.v2" });
    await noAdapter.tick();
    expect(getOccurrence("ops/sweep@2026-10-15T10:10:00.000Z")!.dispatch.state).toBe("pending");
    expect(noAdapter.effects).toEqual([]);
    reopen();
    const withAdapter = processFixture(owner, { entries: [entry()], clock, generation: "work.v2", pid: 5001 });
    await withAdapter.tick();
    expect(getOccurrence("ops/sweep@2026-10-15T10:10:00.000Z")!.dispatch.state).toBe("accepted");
    expect(withAdapter.effects).toEqual([]);
    expect(owner.admissions()).toHaveLength(1);
  });

  it("records a Work choice for an inline action as legacy, with the reason", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const inline = entry({ payload: { kind: "inline", manifest: scriptAction } });
    const p = processFixture(null, { entries: [inline], clock, generation: "work.v2" });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick();
    const { occurrence } = getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!;
    expect(occurrence.executorGeneration).toBe("legacy");
    expect(occurrence.policy).toMatchObject({ generation_note: "inline actions have no Work definition" });
  });
});

describe("crash windows on the legacy generation", () => {
  it("dispatches an occurrence recorded just before a crash, once, after restart", async () => {
    const clock = { now: at("2026-10-15T10:05:00Z") };
    const e = entry();
    // What considerDurable commits, then the process dies before dispatching.
    recordOccurrence({
      occurrence: newScheduleOccurrence({ entry: e, kind: "slot", discriminator: at("2026-10-15T10:05:00Z"), policy: { late: false, coalesced_slots: 1 }, generation: "legacy" }),
      state: "pending",
      statePatch: { trigger_key: JSON.stringify(e.schedule.trigger), next_fire_at: at("2026-10-15T10:10:00Z"), last_fired_at: clock.now },
      now: clock.now,
    });
    reopen();
    const p = processFixture(null, { entries: [e], clock, generation: "legacy", pid: 5001 });
    await p.tick();
    await p.tick();
    expect(p.effects).toEqual(["action:ops/sweep"]);
    expect(getOccurrence("ops/sweep@2026-10-15T10:05:00.000Z")!.dispatch).toMatchObject({ state: "accepted", outcome: "complete" });
  });

  it("never re-runs a script/agent occurrence a dead scheduler may have started", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const first = processFixture(null, { entries: [entry()], clock, generation: "legacy", pid: 5000, holdActions: true });
    await first.scheduler.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await first.scheduler.tick();
    expect(first.effects).toEqual(["action:ops/sweep"]);
    reopen(); // the first process is gone mid-run
    const second = processFixture(null, { entries: [entry()], clock, generation: "legacy", pid: 5001, probe: () => "gone" });
    await second.tick();
    advance(clock, 120_000);
    await second.tick();
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(getOccurrence(id)!.dispatch).toMatchObject({ state: "unknown", lastErrorCode: "legacy_outcome_unknown" });
    expect(second.effects.filter((x) => x === "action:ops/sweep")).toHaveLength(0);
    // Later slots still run: one unresolved occurrence does not wedge the schedule.
    expect(second.effects).toEqual([]);
    clock.now = at("2026-10-15T10:10:00Z");
    await second.tick();
    expect(second.effects).toEqual(["action:ops/sweep"]);
  });

  it("keys a job occurrence by its slot and recovers its one-off after a crash, instead of making a second", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const job = entry({ payload: { kind: "job", ref: "ops:summarize@1" } });
    const p = processFixture(null, { entries: [job], clock, generation: "legacy", jobAcceptCrashes: 1 });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.tick(); // createAtSchedule commits, then the accept "crashes"
    const id = "ops/sweep@2026-10-15T10:05:00.000Z";
    expect(getOccurrence(id)!.dispatch.state).toBe("unknown");
    advance(clock, 60_000);
    await p.tick();
    const rows = getDb().prepare("SELECT id, idempotency_key FROM one_off").all() as Array<{ id: string; idempotency_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotency_key).toBe(id);
    expect(getOccurrence(id)!.dispatch).toMatchObject({ state: "accepted", workId: rows[0]!.id, outcome: "complete" });
    expect(p.effects).toEqual([`job:${rows[0]!.id}`]);
  });

  it("survives a SIGKILLed dispatcher process: the original key is observed and admitted once", async () => {
    const owner = await ownerFixture();
    const clock = { now: at("2026-10-15T10:05:00Z") };
    const e = entry();
    const occurrence = newScheduleOccurrence({ entry: e, kind: "slot", discriminator: at("2026-10-15T10:05:00Z"), policy: { late: false, coalesced_slots: 1 }, generation: "work.v2" });
    closeDb();
    const childPath = join(root, "dispatcher-child.mts");
    const modules = fileURLToPath(new URL(".", import.meta.url));
    // The child lives in a temp dir, so its one bare import is resolved here.
    const sqlite = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
    writeFileSync(childPath, `
      import Database from ${JSON.stringify(sqlite)};
      import { setDb } from ${JSON.stringify(join(modules, "db.ts"))};
      import { beginDispatch, recordOccurrence } from ${JSON.stringify(join(modules, "work-producer-occurrences.ts"))};
      import { processStartTime } from ${JSON.stringify(join(modules, "process.ts"))};
      const occurrence = JSON.parse(process.env.OCCURRENCE);
      occurrence.slotAt = new Date(occurrence.slotAt);
      setDb(new Database(process.env.DB));
      const now = new Date(process.env.NOW);
      recordOccurrence({ occurrence, state: "pending", now });
      beginDispatch(occurrence.occurrenceId, { pid: process.pid, startedAt: processStartTime(process.pid) }, now);
      process.stdout.write("dispatching\\n");
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, DB: dbPath, NOW: clock.now.toISOString(), OCCURRENCE: JSON.stringify(occurrence) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("dispatching")) resolve(); });
      child.on("exit", (code) => reject(new Error(`child exited early (${code})`)));
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");
    setDb(new Database(dbPath));
    expect(getOccurrence(occurrence.occurrenceId)!.dispatch).toMatchObject({ state: "dispatching", dispatcherPid: child.pid });
    const p = processFixture(owner, { entries: [e], clock, pid: process.pid, probe: probeProcess });
    expect(p.dispatcher.recoverAbandoned()).toEqual([{ occurrenceId: occurrence.occurrenceId, action: "unknown" }]);
    const result = await p.dispatcher.dispatch(occurrence.occurrenceId, e);
    expect(result).toMatchObject({ kind: "accepted", workId: "wrk_1", recovered: false });
    expect(owner.calls).toMatchObject({ lookups: 1, submits: 1 });
    expect(owner.admissions()).toHaveLength(1);
    expect(await p.dispatcher.dispatch(occurrence.occurrenceId, e)).toMatchObject({ kind: "skipped", state: "accepted" });
  });
});

describe("calendar boundaries", () => {
  /** Step a legacy scheduler across [from, to] in `stepMs` ticks and return the slots it recorded. */
  async function walk(e: ScheduleEntry, from: string, to: string, stepMs: number) {
    const clock = { now: at(from) };
    const p = processFixture(null, { entries: [e], clock, generation: "legacy" });
    while (clock.now.getTime() <= at(to).getTime()) {
      await p.tick();
      advance(clock, stepMs);
    }
    return { p, slots: listOccurrences(e.id, 500).map((o) => o.occurrence.slotAt!.toISOString()).sort() };
  }

  /** What the calendar contract (nextFireAfter) says is due in (from, to]. */
  function contract(e: ScheduleEntry, from: string, to: string): string[] {
    const slots: string[] = [];
    let cursor = nextFireAfter(e.schedule.trigger, at(from));
    while (cursor && cursor.getTime() <= at(to).getTime()) {
      slots.push(cursor.toISOString());
      cursor = nextFireAfter(e.schedule.trigger, cursor);
    }
    return slots;
  }

  it("skips the nonexistent spring-forward slot and records every real one once", async () => {
    const e = entry({ trigger: { kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" } }, "spring");
    const { slots, p } = await walk(e, "2026-03-07T05:00:00Z", "2026-03-10T05:00:00Z", 5 * 60_000);
    expect(slots).toEqual(contract(e, "2026-03-07T05:00:00Z", "2026-03-10T05:00:00Z"));
    expect(slots).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    expect(p.effects).toHaveLength(2);
  });

  it("records the repeated fall-back hour as the calendar contract defines it, each slot once", async () => {
    const e = entry({ trigger: { kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" } }, "fall");
    const { slots, p } = await walk(e, "2026-10-31T04:00:00Z", "2026-11-02T08:00:00Z", 5 * 60_000);
    expect(slots).toEqual(contract(e, "2026-10-31T04:00:00Z", "2026-11-02T08:00:00Z"));
    expect(new Set(slots).size).toBe(slots.length);
    // The documented expectation (inventory PI-4): the fall-back hour fires once.
    expect(slots.filter((s) => s.startsWith("2026-11-01"))).toEqual(["2026-11-01T05:30:00.000Z"]);
    expect(p.effects).toHaveLength(slots.length);
  });

  it("coalesces a long sleep into one catch-up occurrence under catch_up: once", async () => {
    const clock = { now: at("2026-10-15T10:01:00Z") };
    const p = processFixture(null, { entries: [entry()], clock, generation: "legacy" });
    await p.tick();
    clock.now = at("2026-10-18T10:01:00Z"); // three days asleep
    await p.tick();
    await p.tick();
    const all = listOccurrences("ops/sweep");
    expect(all).toHaveLength(1);
    expect(all[0]!.occurrence.slotAt?.toISOString()).toBe("2026-10-15T10:05:00.000Z");
    expect(all[0]!.occurrence.policy).toMatchObject({ late: true, coalesced_slots: 864 });
    expect(p.effects).toEqual(["action:ops/sweep"]);
    expect(getState("ops/sweep")?.next_fire_at?.toISOString()).toBe("2026-10-18T10:05:00.000Z");
  });

  it("records a missed slot, without running it, under catch_up: none", async () => {
    const clock = { now: at("2026-10-15T10:01:00Z") };
    const p = processFixture(null, { entries: [entry({ catchUp: "none" })], clock, generation: "legacy" });
    await p.tick();
    clock.now = at("2026-10-18T10:01:00Z");
    await p.tick();
    await p.tick();
    const [missed] = listOccurrences("ops/sweep");
    expect(missed!.dispatch.state).toBe("missed");
    expect(getState("ops/sweep")?.missed_fires).toBe(1);
    expect(p.effects).toEqual([]);
  });

  it("treats a stall within the grace as on time", async () => {
    const clock = { now: at("2026-10-15T10:01:00Z") };
    const p = processFixture(null, { entries: [entry()], clock, generation: "legacy" });
    await p.tick();
    clock.now = at("2026-10-15T10:06:59Z");
    await p.tick();
    expect(listOccurrences("ops/sweep")[0]!.occurrence.policy).toMatchObject({ late: false, coalesced_slots: 1 });
  });
});

describe("overlap", () => {
  it("records skipped slots durably while a run is going (overlap: skip)", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const p = processFixture(null, { entries: [entry()], clock, generation: "legacy", holdActions: true });
    await p.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await p.scheduler.tick();
    clock.now = at("2026-10-15T10:10:00Z");
    await p.scheduler.tick();
    clock.now = at("2026-10-15T10:15:00Z");
    await p.scheduler.tick();
    p.release();
    await p.settle();
    const states = listOccurrences("ops/sweep").map((o) => o.dispatch.state).sort();
    expect(states).toEqual(["accepted", "skipped", "skipped"]);
    expect(getState("ops/sweep")?.skipped_fires).toBe(2);
    expect(p.effects).toEqual(["action:ops/sweep"]);
  });

  it("owes exactly one queued re-run however many slots land, and still owes it after a restart (overlap: queue)", async () => {
    const queue = entry({ overlap: "queue" });
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const first = processFixture(null, { entries: [queue], clock, generation: "legacy", holdActions: true });
    await first.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await first.scheduler.tick();
    for (const t of ["10:10", "10:15", "10:20"]) {
      clock.now = at(`2026-10-15T${t}:00Z`);
      await first.scheduler.tick();
    }
    const kinds = listOccurrences("ops/sweep").map((o) => `${o.occurrence.kind}:${o.dispatch.state}`).sort();
    expect(kinds).toEqual(["queued:pending", "slot:coalesced", "slot:coalesced", "slot:dispatching"]);
    reopen(); // dies with the first run going and the re-run owed
    clock.now = at("2026-10-15T10:21:00Z");
    const second = processFixture(null, { entries: [queue], clock, generation: "legacy", pid: 5001, probe: () => "gone" });
    await second.tick();
    await second.tick();
    expect(second.effects).toEqual(["action:ops/sweep"]);
    const queued = listOccurrences("ops/sweep").find((o) => o.occurrence.kind === "queued")!;
    expect(queued.dispatch).toMatchObject({ state: "accepted", outcome: "complete" });
  });
});

describe("notifications", () => {
  it("retries an undeliverable failure notice without re-running the work, and groups the streak", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const failing = processFixture(null, { entries: [entry()], clock, generation: "legacy", actionFails: true, announceWorks: false });
    await failing.tick();
    for (const t of ["10:05", "10:10", "10:15"]) {
      clock.now = at(`2026-10-15T${t}:00Z`);
      await failing.tick();
    }
    expect(failing.effects).toHaveLength(3);
    expect(pendingNotifications()).toMatchObject([{ transition: "failure", failures: 3 }]);
    reopen();
    clock.now = at("2026-10-15T10:16:00Z");
    const delivering = processFixture(null, { entries: [entry()], clock, generation: "legacy", pid: 5001 });
    await delivering.tick();
    expect(delivering.effects).toEqual([]);
    expect(delivering.announced).toEqual([{ id: "ops/sweep", transition: "failure", summary: "failing (3 in a row): exited 1" }]);
    expect(pendingNotifications()).toEqual([]);
    expect(getState("ops/sweep")).toMatchObject({ failure_announced: true, consecutive_failures: 3 });
    clock.now = at("2026-10-15T10:20:00Z");
    await delivering.tick();
    expect(delivering.announced.map((a) => a.transition)).toEqual(["failure", "recovery"]);
  });
});

describe("login occurrences", () => {
  it("runs a claimed login event once, even across a restart", async () => {
    const clock = { now: at("2026-10-15T10:00:00Z") };
    const login = entry({ trigger: { kind: "login" } });
    const first = processFixture(null, { entries: [login], clock, generation: "legacy" });
    await first.tick(); // first sight
    await first.tick();
    reopen();
    const second = processFixture(null, { entries: [login], clock, generation: "legacy", pid: 5001 });
    await second.tick();
    expect(first.effects).toEqual(["action:ops/sweep"]);
    expect(second.effects).toEqual([]);
    expect(listOccurrences("ops/sweep").map((o) => o.occurrence.occurrenceId)).toEqual(["ops/sweep@login:login-1"]);
  });
});

describe("the default scheduler", () => {
  it("writes no occurrence rows without a ledger", async () => {
    const clock = { now: at("2026-10-15T10:04:59Z") };
    const fires: string[] = [];
    const scheduler = new Scheduler({
      listSchedules: async () => ({ schedules: [entry()], errors: [] }),
      resolveAction: async () => scriptAction,
      runScript: async (_a, e) => {
        fires.push(e.id);
        return { status: "complete", runId: "arn_1", summary: "ok" };
      },
      runAgent: async () => ({ status: "complete", runId: null, summary: "" }),
      runJob: async () => ({ status: "complete", runId: null, summary: "" }),
      announce: async () => true,
      runAtSchedule: async () => ({ outcome: "succeeded", exitCode: 0, runId: null }),
      recoverAtSchedules: () => {},
      runner: { pid: 1, startedAt: null },
      loginEventId: () => null,
      now: () => clock.now,
    });
    await scheduler.tick();
    clock.now = at("2026-10-15T10:05:00Z");
    await scheduler.tick();
    await Promise.all(scheduler.running);
    expect(fires).toEqual(["ops/sweep"]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM work_producer_occurrence").get()).toEqual({ n: 0 });
  });
});
