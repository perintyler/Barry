/** Store/provenance qualification only. The backend must validate its private
 * driver brand before invoking this trusted store method. No native process,
 * physical absence assertion, provider, or credential is supplied by this test. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { WorkflowSessionTurns, workflowSessionId, type WorkflowSessionBackend } from "@barry-rocks/sdk/internal/sessions";
import { closeSessionsDb, getSessionsSqlite } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { WorkflowDestinations } from "./workflow-destinations.js";

let root: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-preparation-refusals-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db"));
});
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); }
});
const evidence = { identity: "preparation-fixture", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const ownerProcess = { pid: 12345, pid_started_at: 123456, hostname: "store-fixture-host", bootIdentity: "store-fixture-boot", startIdentity: "ps_utc_v1" as const };

async function fixture(options: { preparing?: boolean; legacyOwner?: boolean } = {}) {
  const db = getSessionsSqlite(), destinations = new WorkflowDestinations(db, options.legacyOwner ? undefined : ownerProcess);
  const bindingKey = "workflow/preparation", sessionId = workflowSessionId(bindingKey, scope.identity!), key = "workflow/preparation-turn", owner = "preparing-owner";
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "fixture/model", endpoint: "http://fixture.invalid/v1", cwd: root, maxTurns: 1, deadline: Date.now() + 60000 } };
  const input = { text: "Original retained input" };
  let ready!: (value: ReturnType<WorkflowDestinations["admit"]>) => void, failReady!: (error: unknown) => void, rejectPreparation!: (error: Error) => void;
  const admitted = new Promise<ReturnType<WorkflowDestinations["admit"]>>((resolve, reject) => { ready = resolve;failReady = reject; });
  const heldPreparation = new Promise<never>((_resolve, reject) => { rejectPreparation = reject; });
  const backend: WorkflowSessionBackend = {
    enforceable: selected => boundFingerprint(selected) === boundFingerprint(scope),
    lookupSession: async id => { const row = destinations.lookupSession(id);return row && { identity: row.identity, boundFingerprint: row.boundFingerprint }; },
    createSession: async () => { destinations.bind(declaration); },
    lookupTurn: async () => ({ state: "uncertain" }),
    interruptTurn: async () => { destinations.cancel(key);return true; },
    runTurn: async request => {
      const turn = destinations.admit({ key: request.turnId, sessionId: request.sessionId, input: request.input, scope: request.scope });
      expect(destinations.claim(sessionId, turn.turn.id, turn.turn.runId, owner)).toBe(true);
      if (options.preparing !== false) destinations.preparing(turn.turn.runId, owner);
      ready(turn);
      return heldPreparation;
    },
  };
  // The coordinator creates both its actual outer intent and the destination
  // mapping. Holding its backend port represents pre-native work, not a model.
  const coordinator = new WorkflowSessionTurns(workflowTurnsStore, backend);
  expect(await coordinator.ensure(bindingKey, scope)).toBe(sessionId);
  const running = coordinator.turn(key, sessionId, input, scope);
  void running.catch(failReady);
  cleanup.push(async () => { rejectPreparation(new Error("Fixture preparation ended"));await running.catch(() => {}); });
  const mapped = await admitted, turnId = mapped.turn.id, segmentId = mapped.turn.runId;
  const request = { bindingKey, sessionId, turnId, segmentId, owner, declarationHash: boundFingerprint(declaration) };
  const receipts = () => db.prepare("SELECT * FROM session_workflow_preparation_refusals ORDER BY segment_id").all();
  const physical = () => destinations.settlements(turnId);
  const logical = () => JSON.stringify({ turns: db.prepare("SELECT * FROM session_turns").all(), segments: db.prepare("SELECT * FROM session_run_segments").all(),
    journal: db.prepare("SELECT * FROM session_workflow_turns").all(), effects: db.prepare("SELECT * FROM session_call_outcomes").all(),
    interrupts: db.prepare("SELECT * FROM session_interrupts").all(), events: db.prepare("SELECT * FROM session_execution_events").all(), cancellations: db.prepare("SELECT * FROM session_workflow_destination_cancellations").all() });
  const image = () => JSON.stringify({ logical: logical(), physical: physical(), receipts: receipts() });
  return { db, destinations, coordinator, declaration, input, bindingKey, sessionId, key, turnId, segmentId, owner, request, receipts, physical, logical, image };
}

it("commits a bound positive no-native-preparation receipt and physical settlement atomically without logical success", async () => {
  const f = await fixture(), before = f.logical();
  f.destinations.refusePreparation(f.request);
  expect(f.receipts()).toHaveLength(1);
  expect(f.receipts()[0]).toMatchObject({ segment_id: f.segmentId, session_id: f.sessionId, turn_id: f.turnId, owner: f.owner,
    binding_key: f.bindingKey, declaration_hash: boundFingerprint(f.declaration),
    intent_hash: boundFingerprint({ sessionId: f.sessionId, input: f.input, scope }), owner_process_hash: boundFingerprint(ownerProcess),
    proof_kind: "native-preparation-not-invoked@1", refused_at: expect.any(String) });
  expect(f.physical()).toMatchObject([{ phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) }]);
  expect(f.destinations.unsettled()).toEqual([]);expect(f.logical()).toBe(before);
  expect(f.db.prepare("SELECT count(*) n FROM engines").get()).toEqual({ n: 0 });
});

it("settles the retained preparing owner after Stop and logical ownership has ended", async () => {
  const f = await fixture();f.destinations.cancel(f.key);f.destinations.turns(f.bindingKey).released(f.sessionId, f.turnId, f.owner);
  expect(f.db.prepare("SELECT owner,state FROM session_turns WHERE id=?").get(f.turnId)).toEqual({ owner: null, state: "cancelled" });
  const before = f.logical();f.destinations.refusePreparation(f.request);
  expect(f.physical()).toMatchObject([{ phase: "not_started", handle: null, inputAt: null }]);expect(f.receipts()).toHaveLength(1);
  expect(f.logical()).toBe(before);
});

it.each(["owner", "declaration", "turn", "session", "binding"] as const)("rejects changed %s proof binding without any receipt or settlement change", async mismatch => {
  const f = await fixture(), request = { ...f.request }, before = f.image();
  if (mismatch === "owner") request.owner = "different-owner";
  else if (mismatch === "declaration") request.declarationHash = boundFingerprint("different declaration");
  else if (mismatch === "turn") request.turnId = "different-turn";
  else if (mismatch === "session") request.sessionId = "different-session";
  else request.bindingKey = "different-binding";
  expect(() => f.destinations.refusePreparation(request)).toThrow();expect(f.image()).toBe(before);
});

it("rejects a changed outer journal intent instead of blessing its replacement hash", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE session_workflow_turns SET request_hash=? WHERE key=?").run(boundFingerprint("different input"), f.key);
  const before = f.image();expect(() => f.destinations.refusePreparation(f.request)).toThrow();expect(f.image()).toBe(before);
});

it.each(["different", "missing", "legacy"] as const)("rejects %s current owner-process evidence", async kind => {
  const f = await fixture({ legacyOwner: kind === "legacy" });
  const destinations = kind === "different" ? new WorkflowDestinations(f.db, { ...ownerProcess, pid: ownerProcess.pid + 1 })
    : kind === "missing" ? new WorkflowDestinations(f.db) : f.destinations;
  const before = f.image();expect(() => destinations.refusePreparation(f.request)).toThrow();expect(f.image()).toBe(before);
});

it("keeps generic preparing uncertainty: ordinary notStarted cannot stand in for positive refusal proof", async () => {
  const f = await fixture(), before = f.image();
  expect(() => f.destinations.notStarted(f.segmentId, f.owner)).toThrow(/preparation may have started/);
  expect(f.image()).toBe(before);expect(f.receipts()).toEqual([]);
});

it.each(["launching", "handled", "input"] as const)("refuses to overwrite %s physical custody", async phase => {
  const f = await fixture({ preparing: phase !== "launching" });
  if (phase !== "launching") f.destinations.handle(f.segmentId, f.owner, { synthetic: "negative test: handle presence must forbid refusal" });
  if (phase === "input") f.destinations.input(f.segmentId, f.owner);
  const before = f.image();expect(() => f.destinations.refusePreparation(f.request)).toThrow();expect(f.image()).toBe(before);
});

it("replays the exact immutable receipt after store reconstruction and rejects changed replay", async () => {
  const f = await fixture();f.destinations.refusePreparation(f.request);
  const before = f.image(), reconstructed = new WorkflowDestinations(f.db, ownerProcess);
  reconstructed.refusePreparation(f.request);expect(f.image()).toBe(before);
  expect(() => reconstructed.refusePreparation({ ...f.request, declarationHash: boundFingerprint("changed replay") })).toThrow();expect(f.image()).toBe(before);
  expect(() => f.db.prepare("UPDATE session_workflow_preparation_refusals SET owner='changed'").run()).toThrow(/immutable/);
  expect(() => f.db.prepare("DELETE FROM session_workflow_preparation_refusals").run()).toThrow(/immutable/);
});

it("does not decode or rewrite corrupted output while recording pre-native refusal", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE session_turns SET result_json='{bad',continuation_json='{bad' WHERE id=?").run(f.turnId);
  const before = f.logical();f.destinations.refusePreparation(f.request);
  expect(f.receipts()).toHaveLength(1);expect(f.physical()).toMatchObject([{ phase: "not_started", handle: null }]);expect(f.logical()).toBe(before);
});
