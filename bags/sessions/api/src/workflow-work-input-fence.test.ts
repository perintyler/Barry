import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { WorkflowDestinations } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { fenceWorkflowWorkInput, workflowWorkSegmentExcluded } from "./workflow-work-input-fence.js";

// Actual migrated SQLite, coordinator intents and destination claim gates.
// No process, model, native handle or native cessation assertion is fabricated.
let root: string;
beforeEach(() => {
  closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-work-input-fence-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db"));
});
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "selected", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
function fixture() {
  const db = getSessionsSqlite(), destination = new WorkflowDestinations(db), key = "eff-original-work";
  const bindingKey = `work-session:${key}`, sessionId = workflowSessionId(bindingKey, scope.identity!);
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "vendor/model", endpoint: "endpoint", cwd: root, maxTurns: 1, deadline: Date.now() + 60000 } };
  const input = { text: "Original accepted Work prompt" }, requestHash = boundFingerprint({ sessionId, input, scope });
  const bind = async () => {
    await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }),
      sessionId, identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" });
    destination.bind(declaration);await workflowTurnsStore.readyBinding(bindingKey);
    await workflowTurnsStore.admitTurn({ key, sessionId, requestHash, state: "active", result: null });
  };
  const admit = () => destination.admit({ key, sessionId, input, scope });
  const fence = () => fenceWorkflowWorkInput(db, declaration, key, requestHash);
  const proof = () => db.prepare("SELECT * FROM session_workflow_work_input_fences WHERE key=?").get(key);
  const cancelled = () => destination.cancelled(key);
  return { db, destination, declaration, key, bindingKey, sessionId, input, requestHash, bind, admit, fence, proof, cancelled };
}

it("commits a bound never-started proof before binding exists and fences later destination admission", async () => {
  const f = fixture();
  expect(f.fence()).toEqual({ neverStarted: true });
  expect(f.cancelled()).toBe(true);
  expect(f.proof()).toMatchObject({ key: f.key, binding_key: f.bindingKey, session_id: f.sessionId, never_started: 1 });
  await f.bind();
  expect(() => f.admit()).toThrow(/cancelled before launch/);
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_destination_turns").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_settlements").get()).toEqual({ n: 0 });
});

it("proves an admitted but never claimed turn never started and excludes its actual next claim", async () => {
  const f = fixture();await f.bind();const admitted = f.admit();
  const before = f.db.prepare("SELECT state,result_json FROM session_turns WHERE id=?").get(admitted.turn.id);
  expect(f.fence()).toEqual({ neverStarted: true });
  expect(workflowWorkSegmentExcluded(f.db, f.declaration, f.key, admitted.turn.id, admitted.turn.runId, f.requestHash)).toBe(true);
  expect(f.destination.claim(f.sessionId, admitted.turn.id, admitted.turn.runId, "owner")).toBe(false);
  expect(f.db.prepare("SELECT state,result_json FROM session_turns WHERE id=?").get(admitted.turn.id)).toEqual(before);
});

it.each(["launching", "not_started"] as const)("never calls historical %s settlement evidence never-started", async phase => {
  const f = fixture();await f.bind();const admitted = f.admit();
  expect(f.destination.claim(f.sessionId, admitted.turn.id, admitted.turn.runId, "owner")).toBe(true);
  if (phase === "not_started") f.destination.notStarted(admitted.turn.runId, "owner");
  expect(f.fence()).toEqual({ neverStarted: false });
  expect(f.proof()).toMatchObject({ never_started: 0 });
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_work_segment_exclusions").get()).toEqual({ n: 0 });
  expect(workflowWorkSegmentExcluded(f.db, f.declaration, f.key, admitted.turn.id, admitted.turn.runId, f.requestHash)).toBe(false);
  expect(f.cancelled()).toBe(true);
});

it("replays the exact immutable proof without replacing its timestamp or hash", async () => {
  const f = fixture();await f.bind();f.admit();
  expect(f.fence()).toEqual({ neverStarted: true });const before = f.proof();
  const exclusions = f.db.prepare("SELECT * FROM session_workflow_work_segment_exclusions").all();
  expect(f.fence()).toEqual({ neverStarted: true });expect(f.proof()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM session_workflow_work_segment_exclusions").all()).toEqual(exclusions);
  expect(() => f.db.prepare("UPDATE session_workflow_work_input_fences SET never_started=0 WHERE key=?").run(f.key)).toThrow(/immutable/);
  expect(() => f.db.prepare("DELETE FROM session_workflow_work_input_fences WHERE key=?").run(f.key)).toThrow(/immutable/);
  expect(() => f.db.prepare("UPDATE session_workflow_work_segment_exclusions SET proof_hash=?").run("a".repeat(64))).toThrow(/immutable/);
  expect(() => f.db.prepare("DELETE FROM session_workflow_work_segment_exclusions").run()).toThrow(/immutable/);
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_destination_cancellations WHERE key=?").get(f.key)).toEqual({ n: 1 });
});

it("appends an exact successor exclusion after a prior stop without changing the original whole-session proof", async () => {
  const f = fixture();await f.bind();const admitted = f.admit();
  expect(f.destination.claim(f.sessionId, admitted.turn.id, admitted.turn.runId, "owner")).toBe(true);
  const own = f.destination.turns(f.bindingKey);
  const paused = own.pause(f.sessionId, admitted.turn.id, "owner", {
    format: "fixture.pending", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "retained", payload: {},
  }, [{ id: "call", tool: "fixture:denied", input: {} }]);
  own.released(f.sessionId, admitted.turn.id, "owner");
  f.destination.notStarted(admitted.turn.runId, "owner");
  expect(f.fence()).toEqual({ neverStarted: false });const original = f.proof();
  // A logical resolver can commit a successor after stop; only the destination
  // native claim gate may authorize preparation, and that gate is now fenced.
  const next = own.resolve({ sessionId: f.sessionId, turnId: admitted.turn.id, requestId: "late-resolution", runId: "late-successor", actor: "fixture",
    decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: false } }] });
  expect(f.destination.claim(f.sessionId, admitted.turn.id, next.runId, "later-owner")).toBe(false);
  expect(workflowWorkSegmentExcluded(f.db, f.declaration, f.key, admitted.turn.id, next.runId, f.requestHash)).toBe(false);
  expect(f.fence()).toEqual({ neverStarted: false });expect(f.proof()).toEqual(original);
  expect(workflowWorkSegmentExcluded(f.db, f.declaration, f.key, admitted.turn.id, next.runId, f.requestHash)).toBe(true);
  expect(workflowWorkSegmentExcluded(f.db, { ...f.declaration, actorId: 2 }, f.key, admitted.turn.id, next.runId, f.requestHash)).toBe(false);
  expect(workflowWorkSegmentExcluded(f.db, f.declaration, f.key, admitted.turn.id, next.runId, boundFingerprint("another intent"))).toBe(false);
});

it("rolls back cross-binding and changed-input requests before installing a cancellation tombstone", async () => {
  const f = fixture();await f.bind();f.admit();
  expect(() => fenceWorkflowWorkInput(f.db, { ...f.declaration, actorId: 2 }, f.key, f.requestHash)).toThrow(/BindingConflict/);
  expect(f.cancelled()).toBe(false);expect(f.proof()).toBeUndefined();
  expect(() => fenceWorkflowWorkInput(f.db, f.declaration, f.key, boundFingerprint("different accepted input"))).toThrow(/BindingConflict/);
  expect(f.cancelled()).toBe(false);expect(f.proof()).toBeUndefined();
});

it("fences independently from malformed logical result/checkpoint JSON without changing it", async () => {
  const f = fixture();await f.bind();const admitted = f.admit();
  expect(f.destination.claim(f.sessionId, admitted.turn.id, admitted.turn.runId, "owner")).toBe(true);
  // Store-owned no-prepare evidence is not native cessation. Its mere history
  // still prevents the stronger never-started proof for the entire session.
  f.destination.notStarted(admitted.turn.runId, "owner");
  f.db.prepare("UPDATE session_turns SET result_json='{malformed',continuation_json='{malformed' WHERE id=?").run(admitted.turn.id);
  const before = f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(admitted.turn.id);
  expect(f.fence()).toEqual({ neverStarted: false });expect(f.cancelled()).toBe(true);
  expect(f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(admitted.turn.id)).toEqual(before);
  expect(f.destination.claim(f.sessionId, admitted.turn.id, admitted.turn.runId, "another-owner")).toBe(false);
});
