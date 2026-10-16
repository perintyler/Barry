/** Transactional metadata tests: synthetic native assertions are not physical-process evidence. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { executionHash, type ContinuationDescriptor } from "@barry-rocks/sdk/sessions";
import { closeSessionsDb, getSessionsSqlite } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { WorkflowDestinations, type WorkflowPhysicalProof } from "./workflow-destinations.js";

let root: string;
beforeEach(() => { closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-physical-recovery-"));vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db")); });
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "metadata-fixture-identity", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint: ContinuationDescriptor = { format: "metadata.fixture", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "original-selection", payload: { original: "conversation" } };
const call = { id: "original-call", tool: "write", input: { path: "/fixture/file", content: "original" } };

async function fixture(options: { legacy?: boolean; beforeInput?: boolean } = {}) {
  const db = getSessionsSqlite(), ownerProcess = { pid: 12345, pid_started_at: 123456, hostname: "synthetic-host", bootIdentity: "synthetic-boot" };
  const destination = new WorkflowDestinations(db, options.legacy ? undefined : ownerProcess);
  const bindingKey = "metadata/run", sessionId = workflowSessionId(bindingKey, scope.identity!), key = "metadata/turn", owner = "original-owner", input = { text: "original input" };
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "fixture/model", endpoint: "http://fixture.invalid/v1", cwd: "/fixture", maxTurns: 3, deadline: 2_000_000_000_000 } };
  await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }), sessionId, identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" });
  destination.bind(declaration);await workflowTurnsStore.readyBinding(bindingKey);
  await workflowTurnsStore.admitTurn({ key, sessionId, requestHash: boundFingerprint({ sessionId, input, scope }), state: "active", result: null });
  const admitted = destination.admit({ key, sessionId, input, scope }), turnId = admitted.turn.id, segmentId = admitted.turn.runId;
  expect(destination.claim(sessionId, turnId, segmentId, owner)).toBe(true);
  destination.preparing(segmentId, owner);
  const handle = { kind: "process", pid: 23456, pgid: 23456, pidStartedAt: 234567, hostname: ownerProcess.hostname, bootIdentity: ownerProcess.bootIdentity, sessionId, turnId, segmentId };
  destination.handle(segmentId, owner, handle);if (!options.beforeInput) destination.input(segmentId, owner);
  const turns = destination.turns(bindingKey);
  const request = () => {
    const revision = turns.snapshot(sessionId, turnId).revision;
    const proof: WorkflowPhysicalProof = { version: 1, bindingKey, key, sessionId, turnId, segmentId, owner,
      handleHash: boundFingerprint(handle), ownerProcessHash: boundFingerprint(ownerProcess), scopeHash: boundFingerprint(scope), selectionHash: boundFingerprint(declaration.selection),
      originalIntentHash: boundFingerprint({ sessionId, input, scope }), revision,
      ownerDead: true, groupAbsent: true, hostname: ownerProcess.hostname, bootIdentity: ownerProcess.bootIdentity, observedAt: 123456789 };
    return { bindingKey, key, sessionId, turnId, segmentId, owner, expectedRevision: revision, proof };
  };
  const image = () => JSON.stringify({ turns: db.prepare("SELECT * FROM session_turns").all(), segments: db.prepare("SELECT * FROM session_run_segments").all(), settlements: db.prepare("SELECT * FROM session_workflow_settlements").all(), outcomeReceipts: db.prepare("SELECT * FROM session_workflow_outcome_recoveries").all(), physicalReceipts: db.prepare("SELECT * FROM session_workflow_physical_settlements").all(), interrupts: db.prepare("SELECT * FROM session_interrupts").all(), journal: db.prepare("SELECT * FROM session_workflow_turns").all(), events: db.prepare("SELECT * FROM session_execution_events").all(), effects: db.prepare("SELECT * FROM session_call_outcomes").all() });
  const logical = () => JSON.stringify({ turns: db.prepare("SELECT * FROM session_turns").all(), segments: db.prepare("SELECT * FROM session_run_segments").all(), effects: db.prepare("SELECT * FROM session_call_outcomes").all(), interrupts: db.prepare("SELECT * FROM session_interrupts").all(), events: db.prepare("SELECT * FROM session_execution_events").all(), outer: db.prepare("SELECT * FROM session_workflow_turns").all(), cancellations: db.prepare("SELECT * FROM session_workflow_destination_cancellations").all() });
  return { db, destination, turns, declaration, key, sessionId, turnId, segmentId, owner, handle, request, image, logical };
}
it("settles only physical metadata and records one immutable receipt without a result, effect verdict or logical transition", async () => {
  const f = await fixture(), request = f.request(), before = f.logical();
  expect(f.destination.settlePhysical(request)).toMatchObject({ segmentId: f.segmentId, phase: "ceased", ceasedAt: expect.any(String) });
  expect(f.logical()).toBe(before);expect(f.destination.unsettled()).toEqual([]);
  const after = f.image();
  expect(new WorkflowDestinations(f.db).settlePhysical({ ...request, proof: { ...request.proof, observedAt: request.proof.observedAt + 1 } })).toMatchObject({ phase: "ceased" });
  expect(f.image()).toBe(after);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 0 });
  expect(() => f.db.prepare("UPDATE session_workflow_physical_settlements SET proof_json='null' WHERE segment_id=?").run(f.segmentId)).toThrow();
  expect(() => f.db.prepare("DELETE FROM session_workflow_physical_settlements WHERE segment_id=?").run(f.segmentId)).toThrow();
  expect(f.image()).toBe(after);
});

it("preserves a cancellation tombstone, cancelled state and completed or unknown effect evidence", async () => {
  const f = await fixture(), paused = f.turns.pause(f.sessionId, f.turnId, f.owner, checkpoint, [call]);
  f.turns.released(f.sessionId, f.turnId, f.owner);
  f.turns.resolve({ sessionId: f.sessionId, turnId: f.turnId, requestId: "approve", runId: "successor", actor: "fixture-reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  // Store-only metadata exercise: no child or provider is represented by this claim.
  expect(f.turns.claim(f.sessionId, f.turnId, "successor-owner")).toBe(true);
  await expect(f.turns.execute(f.sessionId, f.turnId, "successor-owner", call, async () => { throw new Error("No durable effect verdict"); })).rejects.toThrow();
  f.destination.cancel(f.key);const before = f.logical();
  expect(f.destination.settlePhysical(f.request())).toMatchObject({ segmentId: f.segmentId, phase: "ceased" });
  expect(f.logical()).toBe(before);expect(f.destination.cancelled(f.key)).toBe(true);
  expect(f.db.prepare("SELECT state FROM session_call_outcomes").all()).toEqual([{ state: "uncertain" }]);
});

it("settles an older segment after an actual approval names a successor without changing the successor's owner, checkpoint, decisions or effects", async () => {
  const f = await fixture(), paused = f.turns.pause(f.sessionId, f.turnId, f.owner, checkpoint, [call]);
  f.turns.released(f.sessionId, f.turnId, f.owner);
  f.turns.resolve({ sessionId: f.sessionId, turnId: f.turnId, requestId: "approve", runId: "successor", actor: "fixture-reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  expect(f.turns.claim(f.sessionId, f.turnId, "successor-owner")).toBe(true);
  const before = f.logical();expect(f.turns.snapshot(f.sessionId, f.turnId).runId).toBe("successor");
  expect(f.destination.settlePhysical(f.request())).toMatchObject({ segmentId: f.segmentId, phase: "ceased" });
  expect(f.logical()).toBe(before);
  expect(f.db.prepare("SELECT owner,run_id FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ owner: "successor-owner", run_id: "successor" });
});

it("does not require a valid result/checkpoint/interrupt payload to settle otherwise bound physical absence", async () => {
  const f = await fixture(), request = f.request();
  // Corrupt retained logical payload, rather than pretending it is a valid outcome.
  f.db.prepare("UPDATE session_turns SET result_json='{malformed',continuation_json='{malformed' WHERE id=?").run(f.turnId);
  const before = f.logical();expect(f.destination.settlePhysical(request)).toMatchObject({ phase: "ceased" });expect(f.logical()).toBe(before);
});

it.each(["intent", "revision", "binding", "handle", "owner", "scope", "selection", "live-owner", "live-group"] as const)("refuses %s conflict without changing physical or logical rows", async fault => {
  const f = await fixture(), request = f.request();
  if (fault === "intent") request.proof.originalIntentHash = "0".repeat(64);
  if (fault === "revision") { request.expectedRevision++;request.proof.revision++; }
  if (fault === "binding") request.proof.key = "different-key";
  if (fault === "handle") request.proof.handleHash = "0".repeat(64);
  if (fault === "owner") request.owner = "different-owner";
  if (fault === "scope") request.proof.scopeHash = "0".repeat(64);
  if (fault === "selection") request.proof.selectionHash = "0".repeat(64);
  const invalid = fault === "live-owner" ? { ...request, proof: { ...request.proof, ownerDead: false } } : fault === "live-group" ? { ...request, proof: { ...request.proof, groupAbsent: false } } : request;
  const before = f.image();expect(() => f.destination.settlePhysical(invalid)).toThrow();expect(f.image()).toBe(before);
});

it("refuses legacy null owner process evidence even if the caller supplies a synthetic absence assertion", async () => {
  const f = await fixture({ legacy: true }), before = f.image();
  expect(() => f.destination.settlePhysical(f.request())).toThrow();expect(f.image()).toBe(before);
});

it("settles a known inert handled segment before privileged input without manufacturing an input timestamp", async () => {
  const f = await fixture({ beforeInput: true }), before = f.logical();
  expect(f.destination.settlePhysical(f.request())).toMatchObject({ phase: "ceased", inputAt: null });
  expect(f.logical()).toBe(before);expect(f.destination.unsettled()).toEqual([]);
});

it("rejects an earlier observation after a real checkpoint commit advances the turn revision", async () => {
  const f = await fixture(), stale = f.request();
  f.turns.pause(f.sessionId, f.turnId, f.owner, checkpoint, [call]);
  const before = f.image();expect(() => f.destination.settlePhysical(stale)).toThrow(/revision/);expect(f.image()).toBe(before);
});

it("replays the exact original physical receipt after metadata outcome recovery advances the current logical revision", async () => {
  const f = await fixture(), physical = f.request();
  f.destination.settlePhysical(physical);
  const outcome = { type: "completed" as const, result: { original: "retained result" } }, outcomeHash = executionHash(outcome);
  const { originalIntentHash: _intent, revision: _revision, ...physicalBinding } = physical.proof;
  const recovered = f.destination.recoverOutcome({ ...physical, outcome, outcomeHash, proof: { ...physicalBinding, outcomeHash } });
  expect(recovered.revision).toBeGreaterThan(physical.expectedRevision);
  const before = f.image();
  expect(f.destination.settlePhysical(physical)).toMatchObject({ phase: "ceased", segmentId: f.segmentId });
  expect(f.image()).toBe(before);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
});

it("rolls back both physical phase changes and receipt insertion when the real SQLite receipt INSERT aborts", async () => {
  const f = await fixture(), request = f.request();
  f.db.exec("CREATE TRIGGER fixture_abort_physical_receipt BEFORE INSERT ON session_workflow_physical_settlements BEGIN SELECT RAISE(ABORT, 'fixture physical receipt write failure'); END");
  const before = f.image();
  expect(() => f.destination.settlePhysical(request)).toThrow(/fixture physical receipt write failure/);
  expect(f.image()).toBe(before);expect(f.destination.unsettled()).toMatchObject([{ phase: "input", closingAt: null, ceasedAt: null }]);
  f.db.exec("DROP TRIGGER fixture_abort_physical_receipt");
  expect(f.destination.settlePhysical(request)).toMatchObject({ phase: "ceased" });
});
