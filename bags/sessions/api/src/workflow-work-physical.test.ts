import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { encodeEffectJson } from "@barry-rocks/sdk/internal/tools";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { WorkflowDestinations } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import type { SessionsWorkflowBackend } from "./workflow-session-backend.js";
import { inspectWorkflowWorkPhysical } from "./workflow-work-physical.js";
import { fenceWorkflowWorkInput } from "./workflow-work-input-fence.js";

// Real migrated stores and coordinator intents; physical rows here are synthetic
// aggregation inputs, not native cessation evidence. No process or model opens.
let root: string;
beforeEach(() => {
  closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-work-physical-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db"));
});
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "selected", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint = { format: "aggregation.synthetic", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "retained", payload: {} };

async function fixture() {
  const db = getSessionsSqlite(), destination = new WorkflowDestinations(db);
  const key = "work/turn", bindingKey = `work-session:${key}`, sessionId = workflowSessionId(bindingKey, scope.identity!);
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "vendor/model", endpoint: "endpoint", cwd: root, maxTurns: 1, deadline: Date.now() + 60000 } };
  await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }), sessionId,
    identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" });
  destination.bind(declaration);await workflowTurnsStore.readyBinding(bindingKey);
  const input = { text: "Original prompt" };
  await workflowTurnsStore.admitTurn({ key, sessionId, requestHash: boundFingerprint({ sessionId, input, scope }), state: "active", result: null });
  const admitted = destination.admit({ key, sessionId, input, scope }), own = destination.turns(bindingKey);
  // The function's only backend dependency is this real destination store.
  const backend = { destination } as SessionsWorkflowBackend;
  const inspect = (selectedKey = key) => inspectWorkflowWorkPhysical(db, backend, declaration, selectedKey);
  const claim = () => { expect(destination.claim(sessionId, admitted.turn.id, admitted.turn.runId, "owner")).toBe(true); };
  const successor = () => {
    const paused = own.pause(sessionId, admitted.turn.id, "owner", checkpoint, [{ id: "call", tool: "fixture:effect", input: {} }]);
    own.released(sessionId, admitted.turn.id, "owner");
    return own.resolve({ sessionId, turnId: admitted.turn.id, requestId: "approval", runId: "successor", actor: "reviewer",
      decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  };
  const fence = () => fenceWorkflowWorkInput(db, declaration, key, boundFingerprint({ sessionId, input, scope }));
  return { db, destination, declaration, key, sessionId, admitted, own, inspect, claim, successor, fence };
}

it("cannot infer cessation from a missing mapping or an admitted turn with zero fences", async () => {
  const f = await fixture();
  expect(f.inspect("unknown-key")).toEqual({ state: "unknown", terminal: false, allNotStarted: false, turnId: null, segments: 0 });
  expect(f.inspect()).toMatchObject({ state: "unknown", terminal: false, allNotStarted: false, turnId: f.admitted.turn.id, segments: 1 });
});

it("does not promote aggregate physical cessation into logical terminal completion", async () => {
  const f = await fixture();f.claim();f.destination.notStarted(f.admitted.turn.runId, "owner");
  expect(f.inspect()).toMatchObject({ state: "ceased", terminal: false, allNotStarted: true, segments: 1 });
  expect(f.db.prepare("SELECT state FROM session_turns WHERE id=?").get(f.admitted.turn.id)).toEqual({ state: "running" });
});

it("requires fences for every actual segment, including a successor with no physical row", async () => {
  const f = await fixture();f.claim();const next = f.successor();
  f.destination.notStarted(f.admitted.turn.runId, "owner");
  expect(f.inspect()).toMatchObject({ state: "unknown", segments: 2 });
  expect(f.destination.claim(f.sessionId, f.admitted.turn.id, next.runId, "successor-owner")).toBe(true);
  f.destination.notStarted(next.runId, "successor-owner");
  expect(f.inspect()).toMatchObject({ state: "ceased", terminal: false, allNotStarted: true, segments: 2 });
});

it("combines a settled predecessor with positive never-claimed successor exclusion after stop", async () => {
  const f = await fixture();f.claim();const next = f.successor();
  // The predecessor was genuinely never prepared in this store fixture. Its
  // settled physical fence already counts as aggregate cessation; no native
  // process/handle or native absence proof is invented for either segment.
  f.destination.notStarted(f.admitted.turn.runId, "owner");
  expect(f.inspect()).toMatchObject({ state: "unknown", allNotStarted: false, segments: 2 });
  const before = f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id);
  expect(f.fence()).toEqual({ neverStarted: false });
  expect(f.destination.claim(f.sessionId, f.admitted.turn.id, next.runId, "successor-owner")).toBe(false);
  expect(f.inspect()).toMatchObject({ state: "ceased", terminal: false, allNotStarted: true, segments: 2 });
  expect(f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id)).toEqual(before);
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_settlements WHERE segment_id=?").get(next.runId)).toEqual({ n: 0 });
});

it("never substitutes a segment exclusion for an existing unknown native fence", async () => {
  const f = await fixture();f.claim();const next = f.successor();
  f.destination.notStarted(f.admitted.turn.runId, "owner");
  expect(f.destination.claim(f.sessionId, f.admitted.turn.id, next.runId, "successor-owner")).toBe(true);
  expect(f.fence()).toEqual({ neverStarted: false });
  expect(f.db.prepare("SELECT count(*) n FROM session_workflow_work_segment_exclusions").get()).toEqual({ n: 0 });
  expect(f.inspect()).toMatchObject({ state: "unknown", allNotStarted: false, segments: 2 });
});

it("requires the current cancellation tombstone as well as the immutable exclusion", async () => {
  const f = await fixture();
  expect(f.fence()).toEqual({ neverStarted: true });
  expect(f.inspect()).toMatchObject({ state: "ceased", allNotStarted: true });
  f.db.prepare("DELETE FROM session_workflow_destination_cancellations WHERE key=?").run(f.key);
  expect(f.inspect()).toMatchObject({ state: "unknown", allNotStarted: false });
});

it.each(["orphan", "wrong-session", "wrong-turn"] as const)("refuses aggregate cessation with a %s settlement", async corruption => {
  const f = await fixture();f.claim();f.destination.notStarted(f.admitted.turn.runId, "owner");
  if (corruption === "orphan") {
    f.db.prepare("INSERT INTO session_workflow_settlements(segment_id,session_id,turn_id,owner,phase,ceased_at,created_at) VALUES(?,?,?,'fixture','not_started',?,?)")
      .run("not-an-actual-segment", f.sessionId, f.admitted.turn.id, new Date().toISOString(), new Date().toISOString());
  } else if (corruption === "wrong-session") {
    f.db.prepare("UPDATE session_workflow_settlements SET session_id='other-session' WHERE segment_id=?").run(f.admitted.turn.runId);
  } else {
    // A second real turn provides a foreign-key-valid mismatched settlement.
    f.own.finish(f.sessionId, f.admitted.turn.id, "owner", { state: "completed", result: {} });
    await workflowTurnsStore.updateTurn(f.key, "complete", encodeEffectJson({}));
    const otherKey = "other-turn", input = { text: "Other" };
    expect(await workflowTurnsStore.admitTurn({ key: otherKey, sessionId: f.sessionId, requestHash: boundFingerprint({ sessionId: f.sessionId, input, scope }), state: "active", result: null })).toBe(true);
    const other = f.destination.admit({ key: otherKey, sessionId: f.sessionId, input, scope });
    f.db.prepare("UPDATE session_workflow_settlements SET turn_id=? WHERE segment_id=?").run(other.turn.id, f.admitted.turn.runId);
  }
  expect(f.inspect().state).toBe("unknown");
});

it("retains an older unknown fence even when a successor is synthetically ceased", async () => {
  const f = await fixture();f.claim();const next = f.successor();
  // Deliberately inconsistent recovery input: the store's normal claim refuses
  // this successor while the earlier launching fence is unknown.
  expect(f.destination.claim(f.sessionId, f.admitted.turn.id, next.runId, "successor-owner")).toBe(false);
  const at = new Date().toISOString();
  f.db.prepare("INSERT INTO session_workflow_settlements(segment_id,session_id,turn_id,owner,phase,ceased_at,created_at) VALUES(?,?,?,'fixture','not_started',?,?)")
    .run(next.runId, f.sessionId, f.admitted.turn.id, at, at);
  expect(f.inspect()).toMatchObject({ state: "unknown", terminal: false, allNotStarted: false, segments: 2 });
});

it("preserves known physical cessation independently from malformed result and checkpoint JSON", async () => {
  const f = await fixture();f.claim();
  f.destination.handle(f.admitted.turn.runId, "owner", { synthetic: "already-ceased" });
  f.destination.closing(f.admitted.turn.runId, "owner");f.destination.ceased(f.admitted.turn.runId, "owner");
  f.own.finish(f.sessionId, f.admitted.turn.id, "owner", { state: "completed", result: { retained: true } });
  f.db.prepare("UPDATE session_turns SET result_json='{malformed',continuation_json='{also-malformed' WHERE id=?").run(f.admitted.turn.id);
  const before = f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id);
  expect(f.inspect()).toMatchObject({ state: "ceased", terminal: true, allNotStarted: false, segments: 1 });
  expect(f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id)).toEqual(before);
});
