import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import type { ContinuationDescriptor } from "@barry-rocks/sdk/sessions";
import { getSessionsSqlite, closeSessionsDb } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { TurnContinuations } from "./turn-continuations.js";
import { WorkflowDestinations } from "./workflow-destinations.js";

let root: string;
beforeEach(() => {
  closeSessionsDb(); root = mkdtempSync(join(tmpdir(), "workflow-destinations-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db"));
});
afterEach(() => { closeSessionsDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const evidence = { identity: "selected-identity", traits: ["narrow"], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const selection = { harness: "pi", model: "fixture/model", endpoint: "fixture-endpoint", cwd: "/fixture/workspace", maxTurns: 2, deadline: 2_000_000_000_000 };
const checkpoint: ContinuationDescriptor = { format: "fixture.durable", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "retained-config", payload: { exact: "proposal" } };
const call = { id: "original-call", tool: "fixture:effect", input: { exact: "original" } };
async function binding(suffix = "one") {
  const db = getSessionsSqlite(), destinations = new WorkflowDestinations(db);
  const bindingKey = `owner/run-${suffix}`, sessionId = workflowSessionId(bindingKey, scope.identity!);
  const request = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope, selection };
  expect(await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }), sessionId, identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" })).toBe(true);
  destinations.bind(request); await workflowTurnsStore.readyBinding(bindingKey);
  const admit = async (key = `owner/turn-${suffix}`, input: unknown = { text: "Original input" }) => {
    expect(await workflowTurnsStore.admitTurn({ key, sessionId, requestHash: boundFingerprint({ sessionId, input, scope }), state: "active", result: null })).toBe(true);
    const admitted = destinations.admit({ key, sessionId, input, scope });
    return { ...admitted, key, input };
  };
  return { db, destinations, bindingKey, sessionId, request, admit };
}

it("persists inert real sessions and one actual destination turn across store reconstruction", async () => {
  const f = await binding();
  expect(f.db.prepare("SELECT active,state,status,identity_id,user_id FROM sessions WHERE id=?").get(f.sessionId)).toEqual({ active: 0, state: "open", status: "pending", identity_id: 42, user_id: 1 });
  expect(f.db.prepare("SELECT count(*) AS n FROM engines").get()).toEqual({ n: 0 });
  const first = await f.admit(); expect(first.created).toBe(true);
  closeSessionsDb();
  const db = getSessionsSqlite(), reconstructed = new WorkflowDestinations(db);
  const replay = reconstructed.admit({ key: first.key, sessionId: f.sessionId, input: first.input, scope });
  expect(replay).toEqual({ turn: first.turn, created: false });
  expect(db.prepare("SELECT count(*) AS n FROM session_turns").get()).toEqual({ n: 1 });
  expect(reconstructed.turns(f.bindingKey).byRun(f.sessionId, first.turn.runId)).toMatchObject({ turn: { id: first.turn.id }, input: first.input, initial: true });
  expect(() => reconstructed.admit({ key: first.key, sessionId: f.sessionId, input: { text: "Changed" }, scope })).toThrow("matching active turn intent");
});
it("rejects missing coordinator intent, changed declarations and real-session ceiling tampering", async () => {
  const f = await binding();
  expect(() => f.destinations.bind({ ...f.request, bindingKey: "absent", sessionId: workflowSessionId("absent", scope.identity!) })).toThrow("matching session binding intent");
  expect(() => f.destinations.bind({ ...f.request, selection: { ...selection, model: "another/model" } })).toThrow("declaration conflict");
  expect(() => f.destinations.bind({ ...f.request, actorId: 2 })).toThrow("declaration conflict");
  f.db.prepare("UPDATE sessions SET bound=? WHERE id=?").run('{"tools":{"deny":["*:Write"]}}', f.sessionId);
  expect(() => f.destinations.lookupSession(f.sessionId)).toThrow("execution ceiling mismatch");
});
it("records cancellation before destination admission and never allows that key to launch", async () => {
  const f = await binding(); const key = "cancel-before-admit", input = { text: "Never deliver" };
  expect(f.destinations.cancel(key)).toBeUndefined();
  expect(await workflowTurnsStore.admitTurn({ key, sessionId: f.sessionId, requestHash: boundFingerprint({ sessionId: f.sessionId, input, scope }), state: "active", result: null })).toBe(true);
  expect(() => new WorkflowDestinations(f.db).admit({ key, sessionId: f.sessionId, input, scope })).toThrow("cancelled before launch");
  expect(f.db.prepare("SELECT count(*) AS n FROM session_turns").get()).toEqual({ n: 0 });
});
it("cancellation after a handle is recorded fences privileged input and retains physical uncertainty", async () => {
  const f = await binding(), a = await f.admit();
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  f.destinations.handle(a.turn.runId, "worker", { native: "fixture-handle" });
  f.destinations.cancel(a.key);
  expect(() => f.destinations.input(a.turn.runId, "worker")).toThrow("fenced");
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "another-worker")).toBe(false);
  expect(f.destinations.unsettled()).toMatchObject([{ segmentId: a.turn.runId, phase: "handled" }]);
});
it("settles cancellation before preparation as known not started and fences all later launch transitions", async () => {
  const f = await binding(), a = await f.admit();
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  f.destinations.cancel(a.key);
  expect(() => f.destinations.preparing(a.turn.runId, "worker")).toThrow("preparation is fenced");
  expect(() => f.destinations.notStarted(a.turn.runId, "stale-owner")).toThrow("ownership mismatch");
  f.destinations.notStarted(a.turn.runId, "worker");
  expect(new WorkflowDestinations(f.db).settlements(a.turn.id)).toMatchObject([{ phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) }]);
  expect(f.destinations.unsettled()).toEqual([]);
  expect(() => f.destinations.handle(a.turn.runId, "worker", { native: "late" })).toThrow("handle is not expected");
  expect(() => f.destinations.input(a.turn.runId, "worker")).toThrow("input is fenced");
  expect(() => f.destinations.preparing(a.turn.runId, "worker")).toThrow("preparation is fenced");
});
it("retains uncertainty once preparation was durably issued even before its handle is available", async () => {
  const f = await binding(), a = await f.admit();
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  f.destinations.preparing(a.turn.runId, "worker");
  expect(() => f.destinations.notStarted(a.turn.runId, "worker")).toThrow("preparation may have started");
  expect(new WorkflowDestinations(f.db).unsettled()).toMatchObject([{ phase: "preparing", handle: null, ceasedAt: null }]);
  f.destinations.handle(a.turn.runId, "worker", { native: "prepared" });
  expect(() => f.destinations.notStarted(a.turn.runId, "worker")).toThrow("preparation may have started");
  f.destinations.closing(a.turn.runId, "worker"); f.destinations.ceased(a.turn.runId, "worker");
  expect(f.destinations.unsettled()).toEqual([]);
});
it("requires ordered owner-bound handle/input/closing proof and never releases input twice", async () => {
  const f = await binding(), a = await f.admit();
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  expect(() => f.destinations.input(a.turn.runId, "worker")).toThrow("fenced");
  expect(() => f.destinations.closing(a.turn.runId, "worker")).toThrow("handle is unknown");
  expect(() => f.destinations.ceased(a.turn.runId, "worker")).toThrow("known closing handle");
  expect(() => f.destinations.handle(a.turn.runId, "stale-owner", { native: "first" })).toThrow("ownership mismatch");
  f.destinations.handle(a.turn.runId, "worker", { native: "first" });
  expect(() => f.destinations.handle(a.turn.runId, "worker", { native: "replacement" })).toThrow("handle conflict");
  f.destinations.input(a.turn.runId, "worker");
  expect(() => f.destinations.input(a.turn.runId, "worker")).toThrow("fenced");
  f.destinations.closing(a.turn.runId, "worker");
  expect(() => f.destinations.ceased(a.turn.runId, "stale-owner")).toThrow("ownership mismatch");
  f.destinations.ceased(a.turn.runId, "worker");
  expect(f.destinations.unsettled()).toEqual([]);
  expect(f.destinations.settlements(a.turn.id)).toMatchObject([{ handle: { native: "first" }, phase: "ceased", inputAt: expect.any(String), closingAt: expect.any(String), ceasedAt: expect.any(String) }]);
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(false);
});
it("retains physical fences after logical completed clears the actual turn owner", async () => {
  const f = await binding(), a = await f.admit(), own = f.destinations.turns(f.bindingKey);
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  f.destinations.handle(a.turn.runId, "worker", { native: "still-closing" }); f.destinations.input(a.turn.runId, "worker");
  own.finish(f.sessionId, a.turn.id, "worker", { state: "completed", result: { retained: "raw-result" } });
  expect(f.db.prepare("SELECT owner,state FROM session_turns WHERE id=?").get(a.turn.id)).toEqual({ owner: null, state: "completed" });
  expect(new WorkflowDestinations(f.db).unsettled()).toMatchObject([{ phase: "input", segmentId: a.turn.runId }]);
  await workflowTurnsStore.updateTurn(a.key, "complete", '{"retained":"raw-result"}');
  const next = await f.admit("next-key");
  expect(f.destinations.claim(f.sessionId, next.turn.id, next.turn.runId, "successor")).toBe(false);
  f.destinations.closing(a.turn.runId, "worker"); f.destinations.ceased(a.turn.runId, "worker");
  expect(f.destinations.claim(f.sessionId, next.turn.id, next.turn.runId, "successor")).toBe(true);
});
it("refuses a continuation segment until its earlier segment physically ceased", async () => {
  const f = await binding(), a = await f.admit(), own = f.destinations.turns(f.bindingKey);
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  f.destinations.handle(a.turn.runId, "worker", { native: "initial" }); f.destinations.input(a.turn.runId, "worker");
  const paused = own.pause(f.sessionId, a.turn.id, "worker", checkpoint, [call]); own.released(f.sessionId, a.turn.id, "worker");
  const resumed = own.resolve({ sessionId: f.sessionId, turnId: a.turn.id, requestId: "approved", runId: "continuation-segment", actor: "reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
  expect(f.destinations.claim(f.sessionId, a.turn.id, resumed.runId, "successor")).toBe(false);
  f.destinations.closing(a.turn.runId, "worker"); f.destinations.ceased(a.turn.runId, "worker");
  expect(f.destinations.claim(f.sessionId, a.turn.id, resumed.runId, "successor")).toBe(true);
});
it("keeps legacy admission, claim, approval and cancellation out of the workflow-owned destination", async () => {
  const f = await binding(), a = await f.admit(), legacy = new TurnContinuations(f.db), own = f.destinations.turns(f.bindingKey);
  expect(() => legacy.admit({ sessionId: f.sessionId, requestId: "legacy", runId: "legacy", actor: "operator", content: "Alternate prompt", policy: { mode: "automatic" } })).toThrow("workflow executor");
  expect(legacy.claim(f.sessionId, a.turn.id, "legacy-owner")).toBe(false); expect(legacy.runnable()).toEqual([]);
  expect(f.destinations.claim(f.sessionId, a.turn.id, a.turn.runId, "worker")).toBe(true);
  const paused = own.pause(f.sessionId, a.turn.id, "worker", checkpoint, [call]); own.released(f.sessionId, a.turn.id, "worker");
  const decision = { sessionId: f.sessionId, turnId: a.turn.id, requestId: "approved", runId: "continuation", actor: "reviewer", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true as const } }] };
  expect(() => legacy.resolve(decision)).toThrow("workflow executor");
  expect(() => legacy.cancel(f.sessionId, a.turn.id)).toThrow("workflow executor");
  f.db.prepare("UPDATE session_interrupts SET expires_at='2000-01-01T00:00:00Z' WHERE turn_id=?").run(a.turn.id);
  expect(legacy.expireDue()).toEqual([]); expect(own.snapshot(f.sessionId, a.turn.id).state).toBe("waiting_for_input");
  expect(own.expireDue()).toHaveLength(1); expect(own.snapshot(f.sessionId, a.turn.id).state).toBe("running");
});
it("reconciles a later ordinary turn despite more than a default page of protected workflow owners", async () => {
  const protectedTurns: Array<{ sessionId: string; turnId: string }> = [];
  const ownerProcess = { pid: 12345, pid_started_at: 100, hostname: "fixture-host" };
  for (let index = 0; index < 35; index++) {
    const f = await binding(`protected-${index}`), a = await f.admit();
    const own = new TurnContinuations(f.db, undefined, ownerProcess, { workflowBinding: f.bindingKey });
    expect(own.claim(f.sessionId, a.turn.id, `protected-owner-${index}`)).toBe(true);
    protectedTurns.push({ sessionId: f.sessionId, turnId: a.turn.id });
  }
  const db = getSessionsSqlite(); db.prepare("INSERT INTO sessions(id) VALUES('ordinary')").run();
  const ordinary = new TurnContinuations(db, undefined, ownerProcess);
  const legacy = ordinary.admit({ sessionId: "ordinary", requestId: "ordinary-request", runId: "ordinary-segment", actor: "owner", content: "Ordinary work", policy: { mode: "automatic" } });
  expect(ordinary.claim("ordinary", legacy.id, "ordinary-owner")).toBe(true);
  const classify = vi.fn(() => ({ state: "dead" as const, reason: "no-process" as const }));
  ordinary.reconcileOwners(classify);
  expect(classify).toHaveBeenCalledOnce(); expect(ordinary.snapshot("ordinary", legacy.id).state).toBe("recovery_required");
  for (const protectedTurn of protectedTurns) expect(ordinary.snapshot(protectedTurn.sessionId, protectedTurn.turnId).state).toBe("running");
  expect(db.prepare("SELECT count(*) AS n FROM session_turns WHERE owner_checked_at IS NOT NULL AND session_id<>'ordinary'").get()).toEqual({ n: 0 });
});
