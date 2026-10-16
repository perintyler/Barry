import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutorJournal } from "./executor-journal.js";
import { executionBindingSchema, executorStartSchema } from "./work-contracts.js";
import { connectWorkOwnerV3, workWorkerSchema } from "./protocol.js";
import { WorkActivityWorker, type WorkActivitySupervisor, type WorkExecutorFamily } from "./work-activity-worker.js";
import type { ActivityTask } from "./types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Worker family fixture cleanup failed");
});

/** A real durable claim journal and v3 codec, with an inert structural supervisor.
 * These cases qualify worker orchestration, not Sessions/native authority. */
function fixture(executor?: WorkExecutorFamily, input: { claimed?: "agent" | "process"; permit?: "agent" | "process"; advertised?: WorkExecutorFamily; loseBegin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "work-worker-family-"));
  const journal = new ExecutorJournal({ path: join(root, "executor.db"), installation: "host" });
  const family = executor ?? "process", resource = family === "structured-agent" ? "agent" : "process";
  const start = executorStartSchema.parse({
    version: 2, owner: "owner", work_id: "work", workflow_id: "workflow", activity_id: "activity", attempt_id: "attempt",
    request_hash: "a".repeat(64), plan_digest: "b".repeat(64), grant_ref: "grant", grant_revision: 1,
    source: { digest: "c".repeat(64), bytes: 1, purpose: "source", owner_identity: null, media_type: "text/javascript" },
    execution_fence: 1, deadline: Date.now() + 60000, launch_authorized: false, inputs: null,
    effect_policy: { class: "non-repeatable", max_attempts: 1 }, executor_generation: "test",
    resources: { executor: input.claimed ?? resource, lane: "unscheduled", logical_reservation: "logical", host_reservation: null, endpoint: null },
  });
  const permit = executorStartSchema.parse({ ...start, launch_authorized: true,
    resources: { ...start.resources, executor: input.permit ?? start.resources.executor, host_reservation: "held-host" } });
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));
  const task: ActivityTask = { owner: "owner", runId: "workflow", activityId: "activity", idempotencyKey: "effect", type: "fixture",
    input: null, attempt: 1, token: "attempt", deadline: start.deadline, timeoutMs: 60000, heartbeatMs: 1000,
    artifact: start.source.digest, grantRevision: 1, work: start };
  const owns = new Set<string>();
  const launch = vi.fn(async (value: ActivityTask) => { owns.add(value.token);return journal.start(value.work!); });
  const supervisor: WorkActivitySupervisor = {
    bootIdentity: "boot", start: launch, resumeValidation: async value => journal.inspect(value), recoverReceipt: value => journal.receipt(value),
    inspect: value => ({ observation: journal.inspect(value), receipt: journal.receipt(value) }),
    owns: value => owns.has(value.attempt_id), occupiedCount: () => owns.size, leaseLost: () => {},
    cancel: value => journal.cancel(value), close: async () => {},
  };
  const requests: string[] = [];
  let claimed = false, began = 0;
  const client = connectWorkOwnerV3("owner", async value => {
    const request = workWorkerSchema.parse(value);requests.push(request.operation);
    switch (request.operation) {
      case "hello": return { version: 3, owner: "owner", epoch: "epoch", features: ["work-receipts", "work-observations", "online-effects", "launch-authorizations"], maxEnvelopeBytes: 1048576 };
      case "advertise": return null;
      case "claim": if (claimed) return null;claimed = true;return task;
      case "heartbeat": case "effect": return true;
      case "begin": began++;if (input.loseBegin && began === 1) throw new Error("Lost begin reply");return permit;
      case "inspect": return { observation: { ...binding, revision: 1, observed_at: Date.now(), stage: "intent", physical_state: "not-started",
        effect_certainty: "not-started", cancel_requested: false, reason: null, receipt_ref: null, handle: null }, stop_requested: false };
      default: throw new Error("Unexpected fixture operation: " + request.operation);
    }
  });
  const errors: unknown[] = [], prepare = vi.fn(async (_task: ActivityTask) => {});
  const worker = new WorkActivityWorker({ executor, journal, supervisor, connections: [{ owner: "owner", client }],
    advertisement: { types: ["fixture"], artifacts: { fixture: start.source.digest } }, prepare, onError: error => errors.push(error),
    features: () => ({ version: 2, observed_at: Date.now(), expires_at: Date.now() + 15000, installation: "host", boot_identity: "boot",
      executors: [input.advertised ?? family], features: ["declared-validation"], runtimes: {}, workspaces: [], containment: "portable" }),
  });
  cleanup.push(async () => { try { await worker.close(); } finally { journal.close();rmSync(root, { recursive: true, force: true }); } });
  return { worker, journal, binding, requests, errors, prepare, launch, permit };
}

it.each([undefined, "structured-agent"] as const)("retains the activated permit and launches only the selected family (executor=%s)", async executor => {
  const f = fixture(executor);
  await f.worker.tick();await f.worker.close();
  expect(f.errors).toEqual([]);expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.launch.mock.calls[0][0].work).toEqual(f.permit);
  expect(f.journal.retainedStart(f.binding)).toEqual(f.permit);
  expect(f.journal.claimInbox("owner")).toBeNull();
  expect(f.requests.indexOf("begin")).toBeLessThan(f.requests.indexOf("effect"));
});

it.each(["process", "structured-agent"] as const)("refuses a claimed resource family mismatch before preparation or begin (%s)", async executor => {
  const f = fixture(executor, { claimed: executor === "process" ? "agent" : "process" });
  await f.worker.tick();await f.worker.close();
  expect(f.errors).toHaveLength(1);expect(f.prepare).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();
  expect(f.requests).not.toContain("begin");expect(f.journal.claimInbox("owner")?.task?.token).toBe("attempt");
});

it("rejects a wrong-family begin reply while retaining the assignment without effects or launch", async () => {
  const f = fixture("structured-agent", { permit: "process" });
  await f.worker.tick();await f.worker.close();
  expect(f.errors).toHaveLength(1);expect(f.requests).toContain("begin");expect(f.requests).not.toContain("effect");
  expect(f.launch).not.toHaveBeenCalled();expect(f.journal.claimInbox("owner")?.permit).toBeNull();
  expect(f.journal.claimInbox("owner")?.task?.token).toBe("attempt");
});

it("replays begin from the same durable assignment after a lost reply without claiming or launching twice", async () => {
  const f = fixture("structured-agent", { loseBegin: true });
  await expect.poll(async () => { await f.worker.tick();return f.errors.length; }).toBe(1);
  expect(f.journal.claimInbox("owner")?.task?.token).toBe("attempt");expect(f.launch).not.toHaveBeenCalled();
  await expect.poll(async () => { await f.worker.tick();return f.launch.mock.calls.length; }).toBe(1);
  await f.worker.close();
  expect(f.requests.filter(operation => operation === "claim")).toHaveLength(1);
  expect(f.requests.filter(operation => operation === "begin")).toHaveLength(2);
  expect(f.journal.retainedStart(f.binding)).toEqual(f.permit);expect(f.journal.claimInbox("owner")).toBeNull();
});

it("refuses an advertisement for a different family before asking the owner to claim work", async () => {
  const f = fixture("structured-agent", { advertised: "process" });
  await f.worker.tick();await f.worker.close();
  expect(f.errors).toHaveLength(1);expect(f.requests).toEqual([]);expect(f.launch).not.toHaveBeenCalled();
});
