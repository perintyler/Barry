import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds } from "../bounds/workflow-bounds.js";
import { authorizeRun } from "./approvals.js";
import { dispatchWorkerRequest } from "./protocol.js";
import { WorkflowOwner } from "./workflow-owner.js";
import type { WorkflowDefinition } from "./types.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const definitions: WorkflowDefinition[] = [
  { type: "pinned", version: "1", *run() { return yield { kind: "activity", type: "echo", input: "hi", placement: { nodes: { allow: ["mac"] }, requires: {}, preferNodes: [], prefer: {} } }; } },
  { type: "open", version: "1", *run() { return yield { kind: "activity", type: "echo", input: "hi" }; } },
];
function owner(onWorkerSession?: (worker: string, takeover: boolean) => void) {
  const root = mkdtempSync(join(tmpdir(), "workflow-placement-"));
  const workflows = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), definitions, onWorkerSession, resolveNode: reference => reference === "mac" ? "w-mac" : reference });
  cleanup.push(() => { workflows.close(); rmSync(root, { recursive: true, force: true }); });
  for (const worker of ["w-mac", "w-other", "owner"]) workflows.advertise(worker, { types: ["echo"], artifacts: {}, capacity: 1 });
  return workflows;
}

it("dispatches a step only to the workers its nodes bound allows, by worker name", () => {
  const workflows = owner();
  workflows.start({ id: "run", type: "pinned", version: "1", input: null });
  expect(workflows.claim("w-other")).toBeNull();
  expect(workflows.claim("owner")).toBeNull();
  expect(workflows.claim("w-mac")?.runId).toBe("run");
});

it("keeps a run's work off the workers its granted bound denies, with \"local\" naming the owner", async () => {
  const workflows = owner();
  const job = { identity: "reviewer", traits: [] };
  const scope = await approveWorkflowBounds({ identity: job.identity, bags: [], tools: [], boundByName: async () => undefined, bounds: [{ nodes: { deny: ["mac", "local"] } }] });
  workflows.start({ id: "run", type: "open", version: "1", input: null, job }, "author", undefined, await authorizeRun(job, "author", async () => scope));
  expect(workflows.claim("w-mac")).toBeNull();
  expect(workflows.claim("owner")).toBeNull();
  const excluded = workflows.eligibility("run", -1, true).items[0].workers!;
  expect(excluded.find(worker => worker.worker === "w-mac")?.reason).toBe("NODE_BOUND_EXCLUDED");
  expect(excluded.find(worker => worker.worker === "owner")?.reason).toBe("NODE_BOUND_EXCLUDED");
  expect(workflows.claim("w-other")?.runId).toBe("run");
});

it("refuses an advertised activity outside the worker's owner-authoritative job scope", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-job-scope-"));
  const workflows = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), definitions, permitsWorkerJob: (worker, type) => worker === "scoped" && type === "allowed" });
  cleanup.push(() => { workflows.close(); rmSync(root, { recursive: true, force: true }); });
  workflows.advertise("scoped", { types: ["echo"], artifacts: {}, capacity: 1 });
  workflows.start({ id: "run", type: "open", version: "1", input: null });
  expect(workflows.claim("scoped")).toBeNull();
  expect(workflows.eligibility("run", -1, true).items[0].reason).toBe("WORKER_JOB_SCOPE_EXCLUDED");
});

it.each([false, true])("trusted shared-node workers retain local allow and deny bounds (denied=%s)", async denied => {
  const root = mkdtempSync(join(tmpdir(), "workflow-shared-node-"));
  const workflows = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), definitions, workerNode: worker => worker === "common" ? "owner" : worker });
  cleanup.push(() => { workflows.close(); rmSync(root, { recursive: true, force: true }); });
  workflows.advertise("common", { types: ["echo"], capacity: 1 });
  const job = { identity: "reviewer", traits: [] };
  const scope = await approveWorkflowBounds({ identity: job.identity, traitNames: [], traits: {}, tools: [], boundByName: async () => undefined, bounds: [{ nodes: denied ? { deny: ["local"] } : { allow: ["local"] } }] });
  workflows.start({ id: "run", type: "open", version: "1", input: null, job }, "author", undefined, await authorizeRun(job, "author", async () => scope));
  const task = workflows.claim("common");
  if (denied) expect(task).toBeNull(); else expect(task?.runId).toBe("run");
});

it("revalidates worker scope on recovered claims, heartbeats and completion", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-scope-revalidation-"));
  let permitted = true;
  const workflows = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), definitions, permitsWorkerJob: () => permitted });
  cleanup.push(() => { workflows.close(); rmSync(root, { recursive: true, force: true }); });
  workflows.advertise("worker", { types: ["echo"], artifacts: {}, capacity: 1 });
  workflows.start({ id: "run", type: "open", version: "1", input: null });
  const task = workflows.claim("worker", "request")!;
  expect(task).not.toBeNull();
  permitted = false;
  expect(workflows.claim("worker", "request")).toBeNull();
  expect(workflows.heartbeat("worker", task.token)).toBe(false);
  expect(workflows.completeStatus("worker", task.token, { ok: true, value: "untrusted" })).toBe("stale");
});

it("an authenticated diagnostic probe does not replace or retire the live worker session", () => {
  const enrollment: { worker: string; takeover: boolean }[] = [];
  const workflows = owner((worker, takeover) => enrollment.push({ worker, takeover }));
  workflows.openSession("w-mac", "live-session");
  expect(enrollment).toHaveLength(1);
  expect(dispatchWorkerRequest(workflows, "w-mac", { version: 2, operation: "probe" })).toEqual({ version: 2, owner: workflows.id });
  expect(enrollment).toHaveLength(1); // The enrollment audit callback never runs for a probe.
  expect(() => workflows.assertSession("w-mac", "live-session", workflows.epoch)).not.toThrow();
  expect(() => workflows.openSession("w-mac", "live-session")).not.toThrow();
});

it("an enrollment audit failure rolls back session takeover and leaves the old attempt live", () => {
  let refused = false;
  const workflows = owner(() => { if (refused) throw new Error("audit unavailable"); });
  workflows.openSession("w-mac", "live");
  workflows.start({ id: "audit-run", type: "pinned", version: "1", input: null });
  const task = workflows.claim("w-mac")!;
  refused = true;
  expect(() => workflows.openSession("w-mac", "replacement")).toThrow(/audit unavailable/);
  expect(() => workflows.assertSession("w-mac", "live", workflows.epoch)).not.toThrow();
  expect(workflows.heartbeat("w-mac", task.token)).toBe(true);
  expect(() => workflows.assertSession("w-mac", "replacement", workflows.epoch)).toThrow(/obsolete/);
  refused = false;
  workflows.openSession("w-mac", "replacement");
  expect(() => workflows.assertSession("w-mac", "replacement", workflows.epoch)).not.toThrow();
  expect(workflows.heartbeat("w-mac", task.token)).toBe(false);
});
