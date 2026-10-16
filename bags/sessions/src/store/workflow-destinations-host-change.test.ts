/** Host/boot change: retained physical evidence from another boot or host stays fail-closed. Metadata only; no native process exists. */
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
import * as destinations from "./workflow-destinations.js";

let root: string;
beforeEach(() => { closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-destinations-host-change-"));vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db")); });
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "host-change-identity", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint: ContinuationDescriptor = { format: "metadata.fixture", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "original-selection", payload: { original: "conversation" } };
const call = { id: "original-call", tool: "write", input: { path: "/fixture/file", content: "original" } };
const retainedProcess = { pid: 12345, pid_started_at: 123456, hostname: "original-host", bootIdentity: "original-boot" };
type Current = { hostname: string; bootIdentity: string };
const sameHost: Current = { hostname: "original-host", bootIdentity: "original-boot" };
const rebooted: Current = { hostname: "original-host", bootIdentity: "rebooted-boot" };
const otherHost: Current = { hostname: "restored-host", bootIdentity: "original-boot" };

/** A segment opened by the original process, then observed by a process with `current` host/boot evidence. */
async function fixture(current: Current, handleBoot = retainedProcess.bootIdentity) {
  const db = getSessionsSqlite(), destination = new WorkflowDestinations(db, retainedProcess);
  const bindingKey = "host-change/run", sessionId = workflowSessionId(bindingKey, scope.identity!), key = "host-change/turn", owner = "original-owner", input = { text: "original input" };
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "fixture/model", endpoint: "http://fixture.invalid/v1", cwd: "/fixture", maxTurns: 3, deadline: 2_000_000_000_000 } };
  await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }), sessionId, identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" });
  destination.bind(declaration);await workflowTurnsStore.readyBinding(bindingKey);
  await workflowTurnsStore.admitTurn({ key, sessionId, requestHash: boundFingerprint({ sessionId, input, scope }), state: "active", result: null });
  const admitted = destination.admit({ key, sessionId, input, scope }), turnId = admitted.turn.id, segmentId = admitted.turn.runId;
  expect(destination.claim(sessionId, turnId, segmentId, owner)).toBe(true);
  destination.preparing(segmentId, owner);
  const handle = { kind: "process", pid: 23456, pgid: 23456, pidStartedAt: 234567, hostname: retainedProcess.hostname, bootIdentity: handleBoot, sessionId, turnId, segmentId };
  destination.handle(segmentId, owner, handle);destination.input(segmentId, owner);
  // The restarted service constructs its store with its own (current) owner identity.
  const restarted = new WorkflowDestinations(db, { pid: 34567, pid_started_at: 345678, ...current }), turns = restarted.turns(bindingKey);
  const request = () => {
    const revision = turns.snapshot(sessionId, turnId).revision;
    const proof: WorkflowPhysicalProof = { version: 1, bindingKey, key, sessionId, turnId, segmentId, owner,
      handleHash: boundFingerprint(handle), ownerProcessHash: boundFingerprint(retainedProcess), scopeHash: boundFingerprint(scope), selectionHash: boundFingerprint(declaration.selection),
      originalIntentHash: boundFingerprint({ sessionId, input, scope }), revision,
      ownerDead: true, groupAbsent: true, hostname: current.hostname, bootIdentity: current.bootIdentity, observedAt: 123456789 };
    return { bindingKey, key, sessionId, turnId, segmentId, owner, expectedRevision: revision, proof };
  };
  /** Approval names a successor run, so the only remaining claim barrier is the open physical fence. */
  const successor = () => {
    const paused = turns.pause(sessionId, turnId, owner, checkpoint, [call]);
    turns.released(sessionId, turnId, owner);
    turns.resolve({ sessionId, turnId, requestId: "approve", runId: "successor", actor: "fixture-reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  };
  const image = () => JSON.stringify({ turns: db.prepare("SELECT * FROM session_turns").all(), segments: db.prepare("SELECT * FROM session_run_segments").all(), settlements: db.prepare("SELECT * FROM session_workflow_settlements").all(), outcomeReceipts: db.prepare("SELECT * FROM session_workflow_outcome_recoveries").all(), physicalReceipts: db.prepare("SELECT * FROM session_workflow_physical_settlements").all(), interrupts: db.prepare("SELECT * FROM session_interrupts").all(), journal: db.prepare("SELECT * FROM session_workflow_turns").all() });
  return { db, destination: restarted, turns, sessionId, turnId, segmentId, owner, handle, request, successor, image };
}

it("control: the same host and boot settles the open segment and then admits the successor claim", async () => {
  const f = await fixture(sameHost);
  f.successor();
  expect(f.destination.claim(f.sessionId, f.turnId, "successor", "successor-owner")).toBe(false);
  expect(f.destination.settlePhysical(f.request())).toMatchObject({ segmentId: f.segmentId, phase: "ceased", ceasedAt: expect.any(String) });
  expect(f.destination.unsettled()).toEqual([]);
  expect(f.destination.claim(f.sessionId, f.turnId, "successor", "successor-owner")).toBe(true);
});

it.each([["rebooted", rebooted], ["other host", otherHost]] as const)("refuses physical settlement observed on a %s and keeps the segment open and visible", async (_label, current) => {
  const f = await fixture(current), before = f.image();
  expect(() => f.destination.settlePhysical(f.request())).toThrow("Physical settlement native proof conflict");
  expect(f.image()).toBe(before);
  expect(f.destination.unsettled()).toMatchObject([{ segmentId: f.segmentId, sessionId: f.sessionId, phase: "input", ownerProcess: retainedProcess, ceasedAt: null }]);
  expect(f.db.prepare("SELECT ceased_at FROM session_workflow_settlements WHERE segment_id=?").get(f.segmentId)).toEqual({ ceased_at: null });
  expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 0 });
});

it.each([["rebooted", rebooted], ["other host", otherHost]] as const)("refuses outcome recovery observed on a %s without changing rows", async (_label, current) => {
  const f = await fixture(current), { originalIntentHash: _intent, revision: _revision, ...binding } = f.request().proof;
  const outcome = { type: "completed" as const, result: { retained: true } }, outcomeHash = executionHash(outcome), before = f.image();
  expect(() => f.destination.recoverOutcome({ ...f.request(), outcome, outcomeHash, proof: { ...binding, outcomeHash } })).toThrow("Workflow recovery physical proof conflict");
  expect(f.image()).toBe(before);
});

it("refuses a handle whose boot identity differs from its retained owner even when the proof copies the retained boot", async () => {
  const f = await fixture(sameHost, "earlier-boot"), before = f.image();
  expect(() => f.destination.settlePhysical(f.request())).toThrow("Physical settlement native proof conflict");
  expect(f.image()).toBe(before);expect(f.destination.unsettled()).toMatchObject([{ segmentId: f.segmentId, ceasedAt: null }]);
});

it.each([["rebooted", rebooted], ["other host", otherHost]] as const)("blocks the next claim for the session while the %s segment stays unsettled", async (_label, current) => {
  const f = await fixture(current);
  f.successor();
  expect(() => f.destination.settlePhysical(f.request())).toThrow("Physical settlement native proof conflict");
  const before = f.image();
  // Target (D2 inv 6/BR2 diagnostic): refusal should name the unsettled segment. Today: bare false, no throw, no hang.
  expect(f.destination.claim(f.sessionId, f.turnId, "successor", "successor-owner")).toBe(false);
  expect(f.image()).toBe(before);
  expect(f.db.prepare("SELECT owner,run_id FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ owner: null, run_id: "successor" });
  expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_settlements WHERE session_id=?").get(f.sessionId)).toEqual({ n: 1 });
});

// Target (D2 inv 6, BR2): an audited operator release settles the segment as `uncertain` and unblocks the next claim; flip when fixed.
it("gap G4: exposes no operator release: the module exports and destination methods offer only proof-bound settlement", () => {
  expect(Object.keys(destinations).sort()).toEqual([
    "WorkflowDestinations", "validatedWorkflowDestinationScope", "workflowDestinationSelectionSchema", "workflowOwnerProcessSchema",
    "workflowPhysicalProofSchema", "workflowRecoveryOutcomeJson", "workflowRecoveryOutcomeSchema", "workflowRecoveryProofSchema",
  ].sort());
  const methods = Object.getOwnPropertyNames(WorkflowDestinations.prototype).filter(name => name !== "constructor").sort();
  expect(methods.filter(name => /release|force|abandon|operator|retire|uncertain/i.test(name))).toEqual([]);
  expect(methods.filter(name => /settle|ceased|recover/i.test(name)).sort()).toEqual(["ceased", "recoverOutcome", "settlePhysical", "settlements", "unsettled"].sort());
});

// Target (D2 inv 6, BR2): a diagnostic refusal naming the unsettled segment; flip when fixed.
it("gap G4: the blocked claim gives no diagnostic; the only operator-visible trace is unsettled()", async () => {
  const f = await fixture(rebooted);
  f.successor();
  let thrown: unknown;
  try { expect(f.destination.claim(f.sessionId, f.turnId, "successor", "successor-owner")).toBe(false); } catch (error) { thrown = error; }
  expect(thrown).toBeUndefined();
  expect(f.destination.unsettled().map(row => row.segmentId)).toEqual([f.segmentId]);
});
