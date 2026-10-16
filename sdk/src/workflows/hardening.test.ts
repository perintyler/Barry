import { afterEach, expect, it, vi } from "vitest";
import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowOwner, ActivityWorker, activity, sleep, connectOwner, dispatchWorkerRequest, inspectArtifact, type WorkflowDefinition } from "./index.js";
import { evaluate } from "./evaluator.js";
import { encode, limits, PayloadLimit } from "./types.js";
import { WorkflowStore } from "./workflow-store.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const echo: WorkflowDefinition = { type: "echo", version: "1", *run(input) { return yield activity("echo", input, { heartbeatTimeoutMs: 10, retry: { initialDelayMs: 1 } }); } };
function fixture(definitions = [echo], now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), "workflow-hardening-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "jobs.db");
  const owner = new WorkflowOwner({ id: "owner", path, definitions, now: now ?? (() => 1000) });
  cleanup.push(() => owner.close());
  const db = new DatabaseSync(path); cleanup.push(() => db.close());
  return { owner, db, path };
}
const start = (owner: WorkflowOwner, id = "job", input: string = "hello") => owner.start({ id, type: "echo", version: "1", input });

it("binds keyset cursors to time filters and bounds filtered history by bytes without skipping events", () => {
  let clock = 1000;
  const { owner, db } = fixture([echo], () => clock);
  start(owner, "earlier"); clock = 2000; start(owner, "later");
  expect(owner.listPage({ type: "echo", startedAfter: 2000 }).items.map(run => run.id)).toEqual(["later"]);
  expect(owner.listPage({ startedBefore: 2000 }).items.map(run => run.id)).toEqual(["earlier"]);
  const cursor = owner.listPage({ startedAfter: 1000, limit: 1 }).nextCursor!;
  expect(() => owner.listPage({ startedAfter: 2000, cursor })).toThrow("cursor scope");
  const insert = db.prepare("INSERT INTO workflow_events(run_id,at,type,details) VALUES('later',2000,?,?)");
  for (let count = 0; count < 20; count++) insert.run(count % 2 ? "Other" : "Large", JSON.stringify({ metadata: "x".repeat(120_000) }));
  let after = 0;
  const seen: number[] = [];
  do {
    const page = owner.historyPage("later", { after, type: "Large" });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(limits.envelope);
    expect(page.items.every(event => event.type === "Large")).toBe(true);
    seen.push(...page.items.map(event => event.sequence)); after = page.nextCursor ?? 0;
  } while (after);
  expect(seen).toHaveLength(10); expect(new Set(seen).size).toBe(10);
  expect(owner.historyPage("later", { after: seen[5] - 1, type: "Large" }).items[0].sequence).toBe(seen[5]);
});

it.each(["ABORT", "ROLLBACK"])("rolls back intent, history and groups on SQLite %s without inventing a workflow failure", action => {
  const { owner, db } = fixture();
  db.exec(`CREATE TRIGGER fault BEFORE INSERT ON workflow_commands BEGIN SELECT RAISE(${action}, 'storage fault'); END`);
  expect(() => start(owner)).toThrow("storage fault");
  for (const table of ["workflow_runs", "workflow_events", "workflow_groups", "workflow_commands"]) expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
  db.exec("DROP TRIGGER fault");
  expect(start(owner).status).toBe("running");
});

it.each([false, true])("reopens after an ambiguous commit and resolves the original request receipt (committed=%s)", committed => {
  const { owner } = fixture(); const run = start(owner);
  const store = Reflect.get(owner, "store");
  expect(store).toBeInstanceOf(WorkflowStore);
  const db = Reflect.get(store, "db");
  expect(db).toBeInstanceOf(DatabaseSync);
  const exec = db.exec.bind(db), fault = Object.assign(new Error("uncertain commit"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
  const spy = vi.spyOn(db, "exec").mockImplementation((sql: unknown) => {
    if (sql === "COMMIT") { if (committed) exec(sql); throw fault; }
    exec(sql);
  });
  expect(() => owner.mutate("job", "cancel", "ambiguous", run.revision)).toThrow(fault);
  spy.mockRestore();
  const receipt = owner.receipt("job", "ambiguous");
  expect(Boolean(receipt)).toBe(committed);
  expect(Reflect.get(store, "db") === db).toBe(false);
  expect(owner.mutate("job", "cancel", "ambiguous", run.revision).status).toBe("cancelled");
  expect(owner.history("job").filter(event => event.type === "WorkflowClosed")).toHaveLength(1);
});

it("blocking fences authority while retaining physical occupancy until settlement", () => {
  let clock = 1000, changed = false;
  const definition: WorkflowDefinition = { ...echo, *run(input) { return yield changed ? sleep(10) : activity("echo", input, { heartbeatTimeoutMs: 10, retry: { initialDelayMs: 1 } }); } };
  const { owner } = fixture([definition], () => clock);
  start(owner); owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const first = owner.claim("worker")!;
  changed = true; owner.tick();
  expect(owner.get("job").status).toBe("blocked");
  expect(owner.overview().workers[0].active).toBe(1);
  clock += 100; changed = false;
  start(owner, "unrelated");
  expect(owner.claim("worker")).toBeNull();
  expect(owner.complete("worker", first.token, { ok: true, value: "stale" })).toBe(false);
  const next = owner.claim("worker")!;
  expect(next.runId).toBe("unrelated");
  owner.complete("worker", next.token, { ok: true, value: "ok" });
  owner.resume("job");
  expect(owner.claim("worker")?.attempt).toBe(2);
});

it("admits the exact payload budget through command, history, task and result envelopes", () => {
  const { owner } = fixture();
  const input = "x".repeat(limits.payload - 2);
  expect(Buffer.byteLength(encode(input))).toBe(limits.payload);
  start(owner, "large", input);
  owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker")!;
  expect(task.input).toBe(input);
  expect(dispatchWorkerRequest(owner, "worker", { version: 1, operation: "complete", token: task.token, outcome: { ok: true, value: input } })).toBe(true);
  expect(owner.get("large").status).toBe("completed");
  expect(() => start(owner, "too-big", input + "x")).toThrow("256 KiB");
  expect(() => encode("é".repeat(limits.payload / 2))).toThrow("256 KiB");
});

it("settles oversized activity results without retrying the side effect", async () => {
  const { owner } = fixture(); start(owner);
  let effects = 0;
  const worker = new ActivityWorker({ connections: [connectOwner("owner", async request => dispatchWorkerRequest(owner, "worker", request))], activities: { echo: async () => { effects++; return "x".repeat(limits.payload); } } });
  cleanup.push(() => worker.stop());
  await worker.tick(); await worker.tick();
  expect(effects).toBe(1);
  expect(owner.inspect("job").commands[0].outcome).toMatchObject({ ok: false, error: { code: "ResultTooLarge", retryable: false } });
});

it("keeps awaited ticks progressing on a healthy owner while another owner claim is stalled", async () => {
  const { owner } = fixture(); start(owner);
  let release!: (value: null) => void;
  const stalled = { advertise: async () => {}, claim: () => new Promise<null>(resolve => { release = resolve; }), heartbeat: async () => true, complete: async () => true };
  const worker = new ActivityWorker({ capacity: 2, connections: [stalled, connectOwner("owner", async request => dispatchWorkerRequest(owner, "worker", request))], activities: { echo: async input => input } });
  cleanup.push(() => worker.stop());
  const started = performance.now();
  await worker.tick(); await worker.tick();
  expect(performance.now() - started).toBeLessThan(250);
  expect(owner.get("job").status).toBe("completed");
  release(null); expect(await worker.drain(1000)).toBe(true);
});

it("renews worker leases using monotonic elapsed time after the local wall clock moves backward", async () => {
  const { owner } = fixture(); start(owner);
  let heartbeats = 0;
  const connection = connectOwner("owner", async request => { if ((request as { operation: string }).operation === "heartbeat") heartbeats++; return dispatchWorkerRequest(owner, "worker", request); });
  const worker = new ActivityWorker({ connections: [connection], activities: { echo: async (_input, context) => new Promise(resolve => context.signal.addEventListener("abort", () => resolve(null), { once: true })) } });
  cleanup.push(() => worker.stop());
  await worker.tick(); const before = heartbeats;
  const clock = vi.spyOn(Date, "now").mockReturnValue(-1_000_000);
  try {
    await new Promise(resolve => setTimeout(resolve, 20)); await worker.tick();
    expect(heartbeats).toBeGreaterThan(before);
  } finally { clock.mockRestore(); await worker.drain(50); }
});

it("persists dispatch progress past multiple incompatible candidate pages across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-fairness-")), path = join(root, "jobs.db"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifact = inspectArtifact(fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url)), "echo", "1");
  const definition: WorkflowDefinition = { type: "echo", version: "1", *run(input) { return yield activity(String(input), null); } };
  const options = { id: "owner", path, now: () => 1000, artifacts: [artifact], activityArtifacts: { echo: artifact.digest, missing: "b".repeat(64) }, executor: { evaluate: async (_artifact: unknown, snapshot: Parameters<typeof evaluate>[1]) => evaluate(definition, snapshot), close: async () => {} } };
  const owner = new WorkflowOwner(options); cleanup.push(() => owner.close());
  for (let index = 0; index < 130; index++) start(owner, `incompatible-${String(index).padStart(3, "0")}`, "missing");
  start(owner, "z-compatible", "echo");
  for (let turn = 0; turn < 140; turn++) await owner.pump();
  owner.advertise("worker", { types: ["echo"], artifacts: { echo: artifact.digest }, capacity: 1 });
  expect(owner.claim("worker")).toBeNull();
  await owner.drain(); owner.close();
  const restarted = new WorkflowOwner(options); cleanup.push(() => restarted.close());
  restarted.advertise("worker", { types: ["echo"], artifacts: { echo: artifact.digest }, capacity: 1 });
  expect(restarted.claim("worker")).toBeNull();
  expect(restarted.claim("worker")?.runId).toBe("z-compatible");
});
it("releases a dead owner's evaluator reservation without waiting for its deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-reservation-")), path = join(root, "jobs.db"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifact = inspectArtifact(fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url)), "echo", "1");
  const options = { id: "owner", path, now: () => 1000, artifacts: [artifact], activityArtifacts: { echo: artifact.digest }, executor: { evaluate: async (_artifact: unknown, snapshot: Parameters<typeof evaluate>[1]) => evaluate(echo, snapshot), close: async () => {} } };
  const owner = new WorkflowOwner(options); cleanup.push(() => owner.close());
  start(owner); await owner.pump();
  owner.advertise("worker", { types: ["echo"], artifacts: { echo: artifact.digest }, capacity: 1 });
  const task = owner.claim("worker")!;
  owner.complete("worker", task.token, { ok: true, value: "hello" });
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE workflow_due SET token='dead-evaluator',reserved_until=11000 WHERE run_id='job'").run();
    expect(() => new WorkflowOwner(options)).toThrow(/locked/);
    expect(db.prepare("SELECT token,reserved_until FROM workflow_due WHERE run_id='job'").get()).toMatchObject({ token: "dead-evaluator", reserved_until: 11000 });
  } finally { db.close(); }
  expect(owner.get("job").status).toBe("running");
  owner.close();
  const recovered = new WorkflowOwner(options); cleanup.push(() => recovered.close());
  await recovered.pump();
  expect(recovered.get("job").status).toBe("completed");
  expect(recovered.get("job").outcome).toEqual({ ok: true, value: "hello" });
});
it("preserves old physical occupancy across startup and lease expiry until settlement", () => {
  let clock = 1000;
  const { owner, path } = fixture([echo], () => clock);
  start(owner); owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const original = owner.claim("worker")!;
  owner.close(); clock += 20;
  const recovered = new WorkflowOwner({ id: "owner", path, definitions: [echo], now: () => clock }); cleanup.push(() => recovered.close());
  expect(recovered.inspect("job").commands[0].attempts).toMatchObject([{ attempt: 1, state: "active" }]);
  recovered.tick();
  expect(recovered.inspect("job").commands[0].attempts).toMatchObject([{ attempt: 1, state: "expired" }]);
  clock++; recovered.advertise("worker", { types: ["echo"], capacity: 1 });
  expect(recovered.claim("worker")).toBeNull();
  expect(recovered.settlePhysical("worker", original.token)).toBe(true);
  const retried = recovered.claim("worker")!;
  expect(retried.token).not.toBe(original.token);
  expect(retried.attempt).toBe(2);
  recovered.complete("worker", retried.token, { ok: true, value: "hello" });
  expect(recovered.get("job").status).toBe("completed");
});

it("replays mutation receipts before checking the changed revision", () => {
  const { owner } = fixture(); const run = start(owner);
  const cancelled = owner.mutate("job", "cancel", "request", run.revision);
  expect(owner.mutate("job", "cancel", "request", run.revision)).toEqual(cancelled);
  expect(() => owner.mutate("job", "resume", "request", run.revision)).toThrow("conflict");
});

it("retains run-ID tombstones after bounded pruning", () => {
  const { owner } = fixture(); start(owner); owner.cancel("job");
  for (let count = 0; count < 20 && owner.prune(Date.now() + 1000); count++) { /* bounded retention batches */ }
  expect(start(owner).status).toBe("cancelled");
  expect(start(owner).error).toContain("RunArchived");
  expect(() => start(owner, "job", "different")).toThrow("different start");
});

it("drains completed results before allowing the owner store to close", async () => {
  const { owner } = fixture(); start(owner);
  const worker = new ActivityWorker({ connections: [connectOwner("owner", async request => dispatchWorkerRequest(owner, "worker", request))], activities: { echo: async input => input } });
  await worker.tick();
  expect(await worker.drain(1000)).toBe(true);
  expect(owner.get("job").status).toBe("completed");
});

it("never executes a recovered claim receipt after its lease expires", async () => {
  let clock = 1000, effects = 0;
  const { owner } = fixture([echo], () => clock); start(owner);
  owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker", "lost-claim")!;
  clock += 20;
  const worker = new ActivityWorker({ connections: [{ advertise: async () => {}, claim: async () => task, heartbeat: async token => owner.heartbeat("worker", token), complete: async () => true }], activities: { echo: async input => { effects++; return input; } } });
  await worker.tick(); await worker.drain(100);
  expect(effects).toBe(0);
});

it("uses filter-bound keysets and transactional visibility counters", () => {
  const { owner } = fixture();
  for (let index = 0; index < 6; index++) start(owner, `job-${index}`);
  const first = owner.listPage({ limit: 2, prefix: "job-" });
  const second = owner.listPage({ limit: 2, prefix: "job-", cursor: first.nextCursor! });
  expect(new Set([...first.items, ...second.items].map(run => run.id)).size).toBe(4);
  expect(() => owner.listPage({ limit: 2, principal: "other", cursor: first.nextCursor! })).toThrow("scope");
  owner.cancel(first.items[0].id);
  expect(owner.overview().counts).toMatchObject({ running: 5, cancelled: 1 });
  owner.retentionHold(first.items[0].id, true);
  expect(owner.prune(Date.now() + 1000)).toBe(false);
});

it("filters keyset pages by the blocking reason and workers that actually attempted a step", () => {
  const { owner } = fixture(); start(owner, "policy-job"); start(owner, "policy-job-2");
  owner.advertise("worker-a", { types: ["echo"], capacity: 1 });
  expect(owner.claim("worker-a")?.runId).toBe("policy-job");
  expect(owner.eligibility("policy-job", -1, true).items[0].workers).toMatchObject([{ worker: "worker-a", reason: "CAPACITY_FULL", active: 1, capacity: 1 }]);
  owner.blockExecution("policy-job", "PolicyRevoked: selected capability removed");
  owner.blockExecution("policy-job-2", "PolicyRevoked: selected capability removed");
  expect(owner.listPage({ blockingReason: "PolicyRevoked" }).items.map(run => run.id).sort()).toEqual(["policy-job", "policy-job-2"]);
  expect(owner.listPage({ worker: "worker-a" }).items.map(run => run.id)).toEqual(["policy-job"]);
  const cursor = owner.listPage({ blockingReason: "PolicyRevoked", limit: 1 }).nextCursor!;
  expect(cursor).toBeTruthy();
  expect(() => owner.listPage({ blockingReason: "OutcomeUnknown", limit: 1, cursor })).toThrow("cursor scope");
  expect(owner.listPage({ worker: "worker-b" }).items).toEqual([]);
});

it("distinguishes duplicate, conflicting and stale result acknowledgements", () => {
  const { owner } = fixture(); start(owner);
  owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker")!, outcome = { ok: true as const, value: "done" };
  expect(owner.completeStatus("worker", task.token, outcome)).toBe("accepted");
  expect(owner.completeStatus("worker", task.token, outcome)).toBe("alreadyAccepted");
  expect(owner.completeStatus("worker", task.token, { ok: true, value: "different" })).toBe("conflict");
  expect(owner.completeStatus("other", task.token, outcome)).toBe("stale");
});

it("permanently fences a replaced worker session across owner restart", () => {
  const { owner, path } = fixture(); start(owner);
  owner.openSession("worker", "old"); owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker")!;
  owner.openSession("worker", "new");
  expect(() => owner.openSession("worker", "old")).toThrow("obsolete");
  expect(owner.complete("worker", task.token, { ok: true, value: "stale" })).toBe(false);
  owner.close();
  const restarted = new WorkflowOwner({ id: "owner", path, definitions: [echo] }); cleanup.push(() => restarted.close());
  expect(() => restarted.openSession("worker", "old")).toThrow("obsolete");
  restarted.openSession("worker", "new");
});

it("rolls back real SQLITE_FULL and retains retryable start identity", () => {
  const { owner, db } = fixture();
  // SQLite page limits are connection-local; inject the fault into the owner's
  // actual connection, not a second connection that cannot constrain it.
  const store: unknown = Reflect.get(owner, "store");
  if (!(store instanceof WorkflowStore)) throw new Error("owner store unavailable for fault injection");
  const pages = store.one<{ page_count: number }>("PRAGMA page_count")!.page_count;
  store.run(`PRAGMA max_page_count=${pages + 1}`);
  expect(() => start(owner, "full", "x".repeat(200_000))).toThrow(/full/);
  expect(db.prepare("SELECT count(*) n FROM workflow_runs").get()?.n).toBe(0);
  store.run("PRAGMA max_page_count=2147483646");
  expect(start(owner, "full", "x".repeat(200_000)).status).toBe("running");
});

it("bounds SQLite busy waiting and retries without committing a failed run", () => {
  const { owner, db } = fixture();
  db.exec("BEGIN IMMEDIATE");
  const before = performance.now();
  expect(() => start(owner)).toThrow(/locked/);
  expect(performance.now() - before).toBeLessThan(500);
  db.exec("ROLLBACK");
  expect(start(owner).status).toBe("running");
});

it("preserves terminal monotonicity and one accepted success under seeded lease/control sequences", () => {
  let clock = 1000, seed = 0x51ab;
  const { owner, db } = fixture([echo], () => clock);
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const terminal = new Map<string, string>(), tasks: NonNullable<ReturnType<WorkflowOwner["claim"]>>[] = [];
  for (let step = 0; step < 300; step++) {
    const id = `model-${random() % 12}`, operation = random() % 5;
    start(owner, id); owner.advertise("worker", { types: ["echo"], capacity: 4 });
    if (operation === 0) owner.cancel(id);
    if (operation === 1) { const task = owner.claim("worker"); if (task) tasks.push(task); }
    if (operation === 2 && tasks.length) { const task = tasks[random() % tasks.length]; owner.complete("worker", task.token, { ok: true, value: "same-result" }); }
    if (operation === 3) clock += 20;
    owner.tick();
    for (const run of owner.list()) {
      if (terminal.has(run.id)) expect(run.status).toBe(terminal.get(run.id));
      if (!["running", "blocked"].includes(run.status)) terminal.set(run.id, run.status);
    }
    expect(db.prepare("SELECT command_id FROM workflow_attempts WHERE state='accepted' AND json_extract(outcome,'$.ok')=1 GROUP BY command_id HAVING count(*)>1").all()).toHaveLength(0);
  }
});

it("handles forward wall-clock jumps by timing out overdue runs and expiring active leases", () => {
  let clock = 1000;
  const { owner } = fixture([echo], () => clock);
  owner.start({ id: "short-deadline", type: "echo", version: "1", input: "test", timeoutMs: 5000 });
  owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker");
  expect(task).not.toBeNull();

  // Forward jump past both attempt heartbeat timeout and overall run deadline
  clock = 10000;
  owner.tick();
  expect(owner.get("short-deadline").status).toBe("timed_out");

  // Old worker attempting completion after timeout and expiry is rejected
  const completed = owner.complete("worker", task!.token, { ok: true, value: "late" });
  expect(completed).toBe(false);
});

it("handles backward wall-clock jumps without premature timer resolution", async () => {
  let clock = 10_000;
  const timerDef: WorkflowDefinition = {
    type: "timer-wf",
    version: "1",
    *run() { yield sleep(2000); return "slept"; },
  };
  const { owner } = fixture([timerDef], () => clock);
  owner.start({ id: "timer-job", type: "timer-wf", version: "1", input: null });
  await owner.pump();
  expect(owner.get("timer-job").status).toBe("running");

  // Backward wall-clock jump by 1 hour (3600s)
  clock = 1000;
  owner.tick();
  await owner.pump();
  expect(owner.get("timer-job").status).toBe("running");

  // Advance past original target (10_000 + 2000 = 12_000)
  clock = 12_001;
  owner.tick();
  await owner.pump();
  expect(owner.get("timer-job").status).toBe("completed");
});

it("enforces maximum payload boundaries on input, result, and command groups", () => {
  const { owner } = fixture([echo]);
  expect(() => start(owner, "oversized-input", "x".repeat(limits.payload + 1))).toThrow(PayloadLimit);

  start(owner, "valid-job", "valid");
  owner.advertise("worker", { types: ["echo"], capacity: 1 });
  const task = owner.claim("worker");
  expect(task).not.toBeNull();

  // Result exceeding payload limit
  expect(() => owner.complete("worker", task!.token, { ok: true, value: "x".repeat(limits.payload + 1) })).toThrow(PayloadLimit);
});

it("maintains fair turn progression when an active run competes with a single-step run", async () => {
  const clock = 1000;
  const loopDef: WorkflowDefinition = {
    type: "loop-wf",
    version: "1",
    *run() {
      for (let i = 0; i < 5; i++) {
        yield activity("echo", `step-${i}`);
      }
      return "loop-done";
    },
  };
  const singleDef: WorkflowDefinition = {
    type: "single-wf",
    version: "1",
    *run() {
      yield activity("echo", "single");
      return "single-done";
    },
  };
  const { owner } = fixture([loopDef, singleDef, echo], () => clock);
  owner.start({ id: "loop-run", type: "loop-wf", version: "1", input: null });
  owner.start({ id: "single-run", type: "single-wf", version: "1", input: null });
  await owner.pump();

  owner.advertise("worker", { types: ["echo"], capacity: 2 });
  const tasksSeen: string[] = [];
  for (let turn = 0; turn < 15; turn++) {
    const task = owner.claim("worker");
    if (task) {
      tasksSeen.push(task.runId);
      owner.complete("worker", task.token, { ok: true, value: "ok" });
      await owner.pump();
    }
  }

  // Verify single-run got dispatched and completed without waiting for all loop steps
  expect(tasksSeen).toContain("single-run");
  expect(owner.get("single-run").status).toBe("completed");
});
