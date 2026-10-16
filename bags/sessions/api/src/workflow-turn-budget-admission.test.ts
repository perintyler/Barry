/** Real migrated Sessions journal/coordinator; structural harnesses only.
 * Synthetic handles and affirmative probes below make no native/Pi claim.
 * These regressions are authored before the early budget gate is implemented.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { SessionReconciliationRequired, WorkflowSessionTurns, workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import type { ContinuationDescriptor, ContinuationHarness } from "@barry-rocks/sdk/sessions";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { SessionsWorkflowBackend, type WorkflowHarnessLaunch } from "./workflow-session-backend.js";

let root: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-turn-budget-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db"));
});
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); }
});
const evidence = { identity: "budget-protocol-fixture", traits: [], bound: null, harness: "fixture", tools: { "fixture:write": "write" as const } };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint: ContinuationDescriptor = { format: "fixture.budget", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "fixture", payload: { retained: true } };
const call = { id: "budget-call", tool: "fixture:write", input: { retained: true } };

function fixture(mode: "completed" | "automatic" | "generic-failure", maxTurns = 1) {
  const db = getSessionsSqlite(), bindingKey = "budget/binding", key = "budget/turn", input = { text: "original" };
  const declaration = { bindingKey, sessionId: workflowSessionId(bindingKey, scope.identity!), identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "fixture", model: "fixture/model", endpoint: "http://fixture.invalid/v1", cwd: root, maxTurns, deadline: Date.now() + 60000 } };
  let prepares = 0, inputs = 0, restores = 0, effects = 0, acquires = 0, releases = 0;
  const preparePhases: string[] = [], releasePhases: string[] = [];
  const options = {
    db, declaration, enforceable: (candidate: ApprovedBounds) => boundFingerprint(candidate) === boundFingerprint(scope),
    authorize: async () => {}, authorizeTool: async () => ({ allow: true as const }),
    acquire: async () => {
      acquires++;
      const claimed = db.prepare("SELECT segment_id FROM session_workflow_settlements WHERE ceased_at IS NULL").get() as { segment_id: string };
      return { release: () => {
        const row = db.prepare("SELECT phase FROM session_workflow_settlements WHERE segment_id=?").get(claimed.segment_id) as { phase: string };
        releasePhases.push(row.phase);releases++;
      } };
    },
    prepare: async (launch: WorkflowHarnessLaunch) => {
      prepares++;
      preparePhases.push((db.prepare("SELECT phase FROM session_workflow_settlements WHERE segment_id=?").get(launch.segmentId) as { phase: string }).phase);
      if (mode === "generic-failure") throw new Error("Unclassified preparation failure");
      const harness: ContinuationHarness = { approvalContinuation: "durable",
        validate: descriptor => { expect(descriptor).toEqual(checkpoint); },
        begin: async () => {
          inputs++;
          expect(db.prepare("SELECT phase,input_at FROM session_workflow_settlements WHERE segment_id=?").get(launch.segmentId))
            .toEqual({ phase: "input", input_at: expect.any(String) });
          return mode === "automatic" ? { type: "interrupted", continuation: checkpoint, calls: [call] } : { type: "completed", result: "eligible result" };
        },
        restore: async (_descriptor, decisions, executor) => {
          restores++;inputs++;
          expect(decisions.get(call.id)).toEqual({ allow: true });
          expect(db.prepare("SELECT phase,input_at FROM session_workflow_settlements WHERE segment_id=?").get(launch.segmentId))
            .toEqual({ phase: "input", input_at: expect.any(String) });
          await executor.execute(call, async () => { effects++;return { id: call.id, result: "structural effect" }; });
          return { type: "completed", result: "eligible successor result" };
        },
        interrupt: async () => {}, close: async () => {},
      };
      return { handle: { kind: "process" as const, pid: 50000 + prepares, pgid: 50000 + prepares, pidStartedAt: 1, hostname: "synthetic-unit-host", bootIdentity: "synthetic-unit-boot" },
        activate: async () => harness, proveCessation: async () => true, dispose: async () => {} };
    },
  };
  const backend = new SessionsWorkflowBackend(options), turns = new WorkflowSessionTurns(workflowTurnsStore, backend);
  let expectUncertain = false;
  cleanups.push(async () => {
    if (!expectUncertain) { await backend.close();return; }
    const error = await backend.close().then(() => undefined, failure => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.some(item => item instanceof SessionReconciliationRequired)).toBe(true);
  });
  const fences = () => backend.destination.settlements(backend.destination.inspect(key)!.turnId);
  return { db, options, backend, turns, declaration, key, input, fences, preparePhases, releasePhases,
    get counts() { return { prepares, inputs, restores, effects, acquires, releases }; },
    retainUncertainty: () => { expectUncertain = true; },
  };
}

it("admits the first eligible segment once and commits its input before the structural provider callback", async () => {
  const f = fixture("completed");
  const id = await f.turns.ensure(f.declaration.bindingKey, scope);
  await expect(f.turns.turn(f.key, id, f.input, scope)).resolves.toBe("eligible result");
  expect(f.counts).toEqual({ prepares: 1, inputs: 1, restores: 0, effects: 0, acquires: 1, releases: 1 });
  expect(f.preparePhases).toEqual(["preparing"]);expect(f.releasePhases).toEqual(["ceased"]);
  expect(f.fences()).toMatchObject([{ phase: "ceased", inputAt: expect.any(String), ceasedAt: expect.any(String) }]);
});

it("refuses an automatically approved over-budget successor while launching before invoking prepare", async () => {
  const f = fixture("automatic");
  const id = await f.turns.ensure(f.declaration.bindingKey, scope);
  await expect(f.turns.turn(f.key, id, f.input, scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
  expect(f.counts).toEqual({ prepares: 1, inputs: 1, restores: 0, effects: 0, acquires: 2, releases: 2 });
  expect(f.preparePhases).toEqual(["preparing"]);
  expect(f.fences()).toMatchObject([
    { phase: "ceased", inputAt: expect.any(String), ceasedAt: expect.any(String) },
    { phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) },
  ]);
  expect(f.releasePhases).toEqual(["ceased", "not_started"]);
  expect(f.backend.destination.unsettled()).toEqual([]);
});

it("admits an automatic second segment exactly at the two-segment budget and releases both committed fences", async () => {
  const f = fixture("automatic", 2);
  const id = await f.turns.ensure(f.declaration.bindingKey, scope);
  await expect(f.turns.turn(f.key, id, f.input, scope)).resolves.toBe("eligible successor result");
  expect(f.counts).toEqual({ prepares: 2, inputs: 2, restores: 1, effects: 1, acquires: 2, releases: 2 });
  expect(f.preparePhases).toEqual(["preparing", "preparing"]);
  expect(f.releasePhases).toEqual(["ceased", "ceased"]);
  expect(f.fences()).toHaveLength(2);
  for (const fence of f.fences()) expect(fence).toMatchObject({ phase: "ceased", inputAt: expect.any(String), ceasedAt: expect.any(String) });
  expect(f.backend.destination.unsettled()).toEqual([]);
  expect(f.db.prepare("SELECT count(*) n FROM session_call_outcomes WHERE turn_id=?").get(f.backend.destination.inspect(f.key)!.turnId)).toEqual({ n: 1 });
});

it("keeps generic eligible preparation failure unknown with its preparing fence and lease held", async () => {
  const f = fixture("generic-failure");f.retainUncertainty();
  const id = await f.turns.ensure(f.declaration.bindingKey, scope);
  await expect(f.turns.turn(f.key, id, f.input, scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
  expect(f.counts).toEqual({ prepares: 1, inputs: 0, restores: 0, effects: 0, acquires: 1, releases: 0 });
  expect(f.fences()).toMatchObject([{ phase: "preparing", handle: null, inputAt: null, ceasedAt: null }]);
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_preparation_refusals").get()).toEqual({ n: 0 });
  const image = JSON.stringify(f.fences());
  expect(() => f.backend.destination.notStarted(f.fences()[0]!.segmentId, f.fences()[0]!.owner)).toThrow(/preparation may have started/);
  expect(JSON.stringify(f.fences())).toBe(image);
});

it("counts retained not-started refusals as budget even when none of those segments received input", async () => {
  const f = fixture("completed", 2), id = await f.turns.ensure(f.declaration.bindingKey, scope);
  // Public store operations construct two prior no-native attempts on this
  // actual journal turn. This is metadata setup, not a native refusal proof.
  await workflowTurnsStore.admitTurn({ key: f.key, sessionId: id, requestHash: boundFingerprint({ sessionId: id, input: f.input, scope }), state: "active", result: null });
  let turn = f.backend.destination.admit({ key: f.key, sessionId: id, input: f.input, scope }).turn;
  const store = f.backend.destination.turns(f.declaration.bindingKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner = `structural-refusal-${attempt}`;
    expect(f.backend.destination.claim(id, turn.id, turn.runId, owner)).toBe(true);
    f.backend.destination.notStarted(turn.runId, owner);
    const paused = store.pause(id, turn.id, owner, checkpoint, [{ ...call, id: `prior-${attempt}` }]);
    store.released(id, turn.id, owner);
    turn = store.resolve({ sessionId: id, turnId: turn.id, requestId: `structural-resolution-${attempt}`, runId: randomUUID(), actor: "session-policy",
      decisions: paused.interrupts.filter(item => item.status === "pending").map(item => ({ interruptId: item.id, decision: { allow: true } })) });
  }
  f.backend.execution.recover(turn, undefined, true);
  await f.backend.execution.settled(turn.id);
  expect(f.counts).toEqual({ prepares: 0, inputs: 0, restores: 0, effects: 0, acquires: 1, releases: 1 });
  expect(f.fences()).toHaveLength(3);
  for (const fence of f.fences()) expect(fence).toMatchObject({ phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) });
  expect(f.releasePhases).toEqual(["not_started"]);expect(f.backend.destination.unsettled()).toEqual([]);
});

it("does not relabel a retained preparing fence as not-started when a backend is reconstructed", async () => {
  const f = fixture("completed"), id = await f.turns.ensure(f.declaration.bindingKey, scope);f.retainUncertainty();
  await workflowTurnsStore.admitTurn({ key: f.key, sessionId: id, requestHash: boundFingerprint({ sessionId: id, input: f.input, scope }), state: "active", result: null });
  const turn = f.backend.destination.admit({ key: f.key, sessionId: id, input: f.input, scope }).turn, owner = "retained-preparing-owner";
  expect(f.backend.destination.claim(id, turn.id, turn.runId, owner)).toBe(true);
  f.backend.destination.preparing(turn.runId, owner);
  f.backend.destination.turns(f.declaration.bindingKey).released(id, turn.id, owner);
  const before = JSON.stringify(f.fences()), reopened = new SessionsWorkflowBackend(f.options);
  reopened.execution.recover(turn, f.input, false);
  await reopened.execution.settled(turn.id);
  expect(f.counts).toEqual({ prepares: 0, inputs: 0, restores: 0, effects: 0, acquires: 0, releases: 0 });
  expect(JSON.stringify(f.fences())).toBe(before);
  const error = await reopened.close().then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.some(item => item instanceof SessionReconciliationRequired)).toBe(true);
});
