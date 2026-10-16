/** Transactional metadata tests: synthetic native assertions are not physical-process evidence. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { executionHash, type ContinuationDescriptor, type SegmentOutcome } from "@barry-rocks/sdk/sessions";
import { closeSessionsDb, getSessionsSqlite } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { WorkflowDestinations, workflowRecoveryOutcomeJson, type WorkflowRecoveryProof } from "./workflow-destinations.js";

let root: string;
beforeEach(() => { closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-outcome-recovery-"));vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db")); });
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "metadata-fixture-identity", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint: ContinuationDescriptor = { format: "metadata.fixture", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "original-selection", payload: { original: "conversation" } };
const call = { id: "original-call", tool: "write", input: { path: "/fixture/file", content: "original" } };

async function fixture(options: { legacy?: boolean } = {}) {
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
  destination.handle(segmentId, owner, handle);destination.input(segmentId, owner);
  const turns = destination.turns(bindingKey);
  const request = (outcome: SegmentOutcome = { type: "completed", result: { exact: "retained result" }, conversation: checkpoint }) => {
    const outcomeHash = executionHash(outcome);
    const proof: WorkflowRecoveryProof = { version: 1, bindingKey, key, sessionId, turnId, segmentId, owner, outcomeHash,
      handleHash: boundFingerprint(handle), ownerProcessHash: boundFingerprint(ownerProcess), scopeHash: boundFingerprint(scope), selectionHash: boundFingerprint(declaration.selection),
      ownerDead: true, groupAbsent: true, hostname: ownerProcess.hostname, bootIdentity: ownerProcess.bootIdentity, observedAt: 123456789 };
    return { bindingKey, key, sessionId, turnId, segmentId, owner, expectedRevision: turns.snapshot(sessionId, turnId).revision, outcome, outcomeHash, proof };
  };
  const image = () => JSON.stringify({ turns: db.prepare("SELECT * FROM session_turns").all(), segments: db.prepare("SELECT * FROM session_run_segments").all(), settlements: db.prepare("SELECT * FROM session_workflow_settlements").all(), receipts: db.prepare("SELECT * FROM session_workflow_outcome_recoveries").all(), interrupts: db.prepare("SELECT * FROM session_interrupts").all(), journal: db.prepare("SELECT * FROM session_workflow_turns").all(), events: db.prepare("SELECT * FROM session_execution_events").all(), effects: db.prepare("SELECT * FROM session_call_outcomes").all() });
  return { db, destination, turns, declaration, key, sessionId, turnId, segmentId, owner, handle, request, image };
}

it("atomically repairs raw completion and physical fence exactly once while leaving outer receipt delivery to its coordinator", async () => {
  const f = await fixture(), request = f.request();
  await workflowTurnsStore.updateTurn(f.key, "uncertain");
  const first = f.destination.recoverOutcome(request);
  expect(first).toMatchObject({ state: "completed", result: { exact: "retained result" } });
  expect(f.destination.unsettled()).toEqual([]);
  expect(await workflowTurnsStore.getTurn(f.key)).toMatchObject({ state: "uncertain", result: null });
  const after = f.image();
  expect(new WorkflowDestinations(f.db).recoverOutcome({ ...request, proof: { ...request.proof, observedAt: request.proof.observedAt + 1 } })).toEqual(first);
  expect(f.image()).toBe(after);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT owner FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ owner: null });
});

it("imports checkpoint metadata as waiting and pending without resolving approval or scheduling a successor", async () => {
  const f = await fixture();
  const repaired = f.destination.recoverOutcome(f.request({ type: "interrupted", continuation: checkpoint, calls: [call] }));
  expect(repaired).toMatchObject({ state: "waiting_for_input", runId: f.segmentId, interrupts: [{ call, status: "pending" }] });
  expect(f.destination.unsettled()).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_run_segments").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_call_outcomes").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT owner FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ owner: null });
});

it("retains actual failed outcome metadata without inventing a successful result", async () => {
  const f = await fixture();
  expect(f.destination.recoverOutcome(f.request({ type: "failed", error: "retained failure" }))).toMatchObject({ state: "failed", error: "retained failure" });
  expect(f.destination.unsettled()).toEqual([]);
  expect(f.db.prepare("SELECT result_json FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ result_json: null });
});

it.each(["hash", "binding", "handle", "owner", "scope", "selection", "revision", "live-owner", "live-group"] as const)("rejects %s proof/conflict without changing any durable state", async fault => {
  const f = await fixture(), request = f.request();
  if (fault === "hash") request.outcomeHash = "0".repeat(64);
  if (fault === "binding") request.proof.key = "another-key";
  if (fault === "handle") request.proof.handleHash = "0".repeat(64);
  if (fault === "owner") request.owner = "another-owner";
  if (fault === "scope") request.proof.scopeHash = "0".repeat(64);
  if (fault === "selection") request.proof.selectionHash = "0".repeat(64);
  if (fault === "revision") request.expectedRevision++;
  const before = f.image();
  // Malformed external assertions intentionally bypass static literal types;
  // schema validation must reject them before the writer transaction changes state.
  const untrusted = fault === "live-owner" ? { ...request, proof: { ...request.proof, ownerDead: false } }
    : fault === "live-group" ? { ...request, proof: { ...request.proof, groupAbsent: false } } : request;
  expect(() => f.destination.recoverOutcome(untrusted)).toThrow();
  expect(f.image()).toBe(before);expect(f.destination.unsettled()).toHaveLength(1);
});

it("refuses legacy unknown ownership even with otherwise matching metadata assertions", async () => {
  const f = await fixture({ legacy: true }), before = f.image();
  expect(() => f.destination.recoverOutcome(f.request())).toThrow();expect(f.image()).toBe(before);
});

it("refuses cancellation and does not resurrect the cancelled original intent", async () => {
  const f = await fixture(), request = f.request();f.destination.cancel(f.key);const before = f.image();
  expect(() => f.destination.recoverOutcome(request)).toThrow();expect(f.image()).toBe(before);
});

it("rejects a different outcome after receipt settlement without replacing original output", async () => {
  const f = await fixture();f.destination.recoverOutcome(f.request());const before = f.image();
  expect(() => f.destination.recoverOutcome(f.request({ type: "completed", result: "different" }))).toThrow();
  expect(f.image()).toBe(before);
});

it("refuses a stale segment after an actual approval creates a successor", async () => {
  const f = await fixture(), request = f.request(), paused = f.turns.pause(f.sessionId, f.turnId, f.owner, checkpoint, [call]);
  f.turns.released(f.sessionId, f.turnId, f.owner);
  f.turns.resolve({ sessionId: f.sessionId, turnId: f.turnId, requestId: "approve", runId: "successor", actor: "fixture-reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  const before = f.image();expect(() => f.destination.recoverOutcome(request)).toThrow();expect(f.image()).toBe(before);
});

it("holds recovery when a real approved effect throws and its durable result remains uncertain", async () => {
  const f = await fixture(), paused = f.turns.pause(f.sessionId, f.turnId, f.owner, checkpoint, [call]);
  f.turns.released(f.sessionId, f.turnId, f.owner);f.destination.closing(f.segmentId, f.owner);f.destination.ceased(f.segmentId, f.owner);
  const successor = f.turns.resolve({ sessionId: f.sessionId, turnId: f.turnId, requestId: "approve", runId: "effect-segment", actor: "fixture-reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  expect(f.destination.claim(f.sessionId, f.turnId, successor.runId, f.owner)).toBe(true);
  f.destination.preparing(successor.runId, f.owner);const handle = { ...f.handle, segmentId: successor.runId };
  f.destination.handle(successor.runId, f.owner, handle);f.destination.input(successor.runId, f.owner);
  let effects = 0;
  await expect(f.turns.execute(f.sessionId, f.turnId, f.owner, call, async () => { effects++;throw new Error("real fixture effect refusal"); })).rejects.toThrow();
  const request = f.request();request.segmentId = successor.runId;request.proof.segmentId = successor.runId;request.proof.handleHash = boundFingerprint(handle);
  const before = f.image();expect(() => f.destination.recoverOutcome(request)).toThrow(/uncertain/);expect(f.image()).toBe(before);expect(effects).toBe(1);
});

it("retains a checkpoint above 256KiB through the full 1MiB wire boundary and rejects one extra byte atomically", async () => {
  const f = await fixture();
  const outcome: SegmentOutcome = { type: "interrupted", continuation: { ...checkpoint, payload: { data: "" } }, calls: [call] };
  const overhead = Buffer.byteLength(workflowRecoveryOutcomeJson(outcome));
  if (outcome.type !== "interrupted") throw new Error("Expected checkpoint fixture");
  outcome.continuation.payload = { data: "x".repeat(1048576 - overhead) };
  expect(Buffer.byteLength(workflowRecoveryOutcomeJson(outcome))).toBe(1048576);
  const tooLarge: SegmentOutcome = { ...outcome, continuation: { ...outcome.continuation, payload: { data: "x".repeat(1048577 - overhead) } } };
  const request = f.request(tooLarge), before = f.image();
  expect(() => f.destination.recoverOutcome(request)).toThrow(/limit/);expect(f.image()).toBe(before);
  expect(f.destination.recoverOutcome(f.request(outcome))).toMatchObject({ state: "waiting_for_input" });
  const stored = f.db.prepare("SELECT continuation_json FROM session_turns WHERE id=?").get(f.turnId) as { continuation_json: string };
  expect(JSON.parse(stored.continuation_json)).toEqual(outcome.continuation);
  expect(Buffer.byteLength(stored.continuation_json)).toBeGreaterThan(262144);
});

it("makes the imported recovery receipt immutable against both SQL UPDATE and DELETE", async () => {
  const f = await fixture();f.destination.recoverOutcome(f.request());const before = f.image();
  expect(() => f.db.prepare("UPDATE session_workflow_outcome_recoveries SET outcome_json='null' WHERE segment_id=?").run(f.segmentId)).toThrow();
  expect(f.image()).toBe(before);
  expect(() => f.db.prepare("DELETE FROM session_workflow_outcome_recoveries WHERE segment_id=?").run(f.segmentId)).toThrow();
  expect(f.image()).toBe(before);
});
