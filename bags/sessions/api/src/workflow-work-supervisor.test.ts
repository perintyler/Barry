import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId, type WorkflowSessionTurns } from "@barry-rocks/sdk/internal/sessions";
import { ExecutorJournal, WorkArtifactStore, executionBindingSchema, executorStartSchema, logicalStageEffectKey,
  type WorkOwnerConnection } from "@barry-rocks/sdk/internal/workflows";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { WorkflowDestinations } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { fenceWorkflowWorkInput } from "./workflow-work-input-fence.js";
import type { SessionsWorkflowBackend } from "./workflow-session-backend.js";
import type { WorkflowWorkSession } from "./workflow-work-sessions.js";
import { WorkflowWorkSupervisor } from "./workflow-work-supervisor.js";

// Recovery protocol/store tests only. Actual journals, migrations, destination
// and input fence; inert structural manager/transport and synthetic ceased rows.
// No owner admission, native proof, provider or deployment qualification.
let root: string;
const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => { closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-work-recovery-"));vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db")); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); }
});
const evidence = { identity: "selected", traits: [], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
async function fixture(options: { logicalRunning?: boolean; unreadable?: boolean; schema?: Record<string, unknown>; result?: unknown } = {}) {
  const db = getSessionsSqlite(), destination = new WorkflowDestinations(db), artifacts = new WorkArtifactStore(join(root, "artifacts"));
  let now = Date.now();
  const journal = new ExecutorJournal({ path: join(root, "executor.db"), installation: "installation", now: () => now, artifacts });
  cleanup.push(() => { journal.close();artifacts.close(); });
  const source = artifacts.stage(Buffer.from("{}"), { owner_identity: null, purpose: "source", media_type: "application/json" });
  const start = executorStartSchema.parse({ version: 2, owner: "installation", work_id: "work", workflow_id: "workflow", activity_id: "activity", attempt_id: "attempt",
    request_hash: "a".repeat(64), plan_digest: "b".repeat(64), grant_ref: "grant", grant_revision: 1, source, execution_fence: 1, deadline: now + 60000,
    launch_authorized: true, inputs: { prompt: "Retained" }, effect_policy: { class: "non-repeatable", max_attempts: 1 },
    resources: { executor: "agent", lane: "unscheduled", logical_reservation: "logical", host_reservation: "held-host", endpoint: null }, executor_generation: "sessions-v1",
    agent_program: { activity_type: "agent:fixture", source_digest: source.digest, installation: "installation", scope, profile: source }, activity_type: "agent:fixture", output_identity: "selected",
    validation: options.schema ? { mode: "json-schema", schema: options.schema } : { mode: "none" } });
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));
  journal.start(start);expect(journal.claimStage(binding, "execution").launch).toBe(true);
  const key = logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), bindingKey = `work-session:${key}`;
  const sessionId = workflowSessionId(bindingKey, scope.identity!);
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "vendor/model", endpoint: "endpoint", cwd: root, maxTurns: 1, deadline: start.deadline } };
  const input = { text: "Retained" }, requestHash = boundFingerprint({ sessionId, input, scope });
  await workflowTurnsStore.admitBinding({ key: bindingKey, requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope, existingSessionId: undefined }), sessionId,
    identity: scope.identity!, scopeHash: scope.fingerprint, state: "admitted" });
  destination.bind(declaration);await workflowTurnsStore.readyBinding(bindingKey);
  await workflowTurnsStore.admitTurn({ key, sessionId, requestHash, state: "active", result: null });
  const admitted = destination.admit({ key, sessionId, input, scope });expect(destination.claim(sessionId, admitted.turn.id, admitted.turn.runId, "original-owner")).toBe(true);
  destination.handle(admitted.turn.runId, "original-owner", { synthetic: "ceased-only-unit-evidence" });destination.input(admitted.turn.runId, "original-owner");
  destination.closing(admitted.turn.runId, "original-owner");destination.ceased(admitted.turn.runId, "original-owner");
  if (!options.logicalRunning) {
    destination.turns(bindingKey).finish(sessionId, admitted.turn.id, "original-owner", { state: "completed", result: options.result ?? {} });
    await workflowTurnsStore.updateTurn(key, "complete", JSON.stringify(options.result ?? {}));
  }
  if (options.unreadable) db.prepare("UPDATE session_turns SET result_json='{broken',continuation_json='{broken' WHERE id=?").run(admitted.turn.id);
  const handle = { kind: "session" as const, installation: "installation", session_id: sessionId, turn_id: key };
  journal.recordHandle(binding, "execution", handle);journal.assertStageInput(binding, "execution", handle);
  const startModel = vi.fn(async () => { throw new Error("Recovery must not submit model input"); });
  const lookup = vi.fn(async () => {
    if (options.unreadable) throw new Error("Retained JSON cannot decode");
    return workflowTurnsStore.getTurn(key);
  });
  const fenceInput = vi.fn(async () => fenceWorkflowWorkInput(db, declaration, key, requestHash));
  const session: WorkflowWorkSession = { key, declaration, scope, backend: { destination } as SessionsWorkflowBackend,
    turns: {} as WorkflowSessionTurns, start: startModel, lookup, interrupt: vi.fn(async () => true), fenceInput };
  const sessions = { open: vi.fn(async () => { throw new Error("Recovery must not reopen admission"); }), recover: vi.fn(async () => session), close: vi.fn(async () => {}) };
  const errors: unknown[] = [], supervisor = new WorkflowWorkSupervisor({ installation: "installation", journal, artifacts, sessions,
    clients: new Map<string, WorkOwnerConnection>(), onError: error => errors.push(error) });
  cleanup.push(() => supervisor.close());
  const output = (value: unknown, stage: "execution" | "validation" = "execution") => {
    const reference = artifacts.stage(Buffer.from(JSON.stringify(value)), { owner_identity: "selected", purpose: "output", media_type: "application/json" });
    journal.retainStageOutput(binding, stage, reference);return reference;
  };
  const completeMain = (value: unknown) => {
    const reference = output(value);
    journal.completeStage(binding, { stage: "execution", effect_key: key, attempt_id: binding.attempt_id, state: "passed", started_at: now, completed_at: now, result: reference }, "ceased");
    return reference;
  };
  const recover = async () => {
    supervisor.recoverReceipt(binding);
    await expect.poll(() => journal.receipt(binding)).not.toBeNull();
    await expect.poll(() => supervisor.owns(binding)).toBe(false);
    expect(startModel).not.toHaveBeenCalled();expect(sessions.open).not.toHaveBeenCalled();expect(errors).toEqual([]);
    return journal.receipt(binding)!;
  };
  return { db, destination, journal, artifacts, binding, start, key, declaration, admitted, session, supervisor, errors, output, completeMain, recover, fenceInput,
    expire: () => { now = start.deadline + 1;vi.spyOn(Date, "now").mockReturnValue(now);cleanup.push(() => { vi.restoreAllMocks(); }); } };
}

it("records uncertain physical cessation and durable future-input exclusion despite raw running malformed logical data", async () => {
  const f = await fixture({ logicalRunning: true, unreadable: true }), before = f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id);
  const receipt = await f.recover();
  expect(receipt).toMatchObject({ outcome: "uncertain", physical_state: "ceased", effect_certainty: "uncertain" });
  expect(f.fenceInput).toHaveBeenCalled();expect(f.db.prepare("SELECT never_started FROM session_workflow_work_input_fences WHERE key=?").get(f.key)).toEqual({ never_started: 0 });
  expect(f.db.prepare("SELECT state,result_json,continuation_json FROM session_turns WHERE id=?").get(f.admitted.turn.id)).toEqual(before);
});

it.each([false, true])("recovers a pure validation intent with preexisting output pin=%s without repeating model input", async pinned => {
  const f = await fixture({ schema: { type: "object" } });f.completeMain({});expect(f.journal.claimStage(f.binding, "validation").launch).toBe(true);
  if (pinned) f.output({}, "validation");
  expect(f.journal.inspect(f.binding)?.physical_state).toBe("unknown");
  expect(await f.recover()).toMatchObject({ outcome: "complete", validation: "passed", physical_state: "ceased", effect_certainty: "known" });
});

it.each(["stop", "deadline"] as const)("settles interrupted pure validation after %s with its retained output intact", async cause => {
  const f = await fixture({ schema: { type: "object" } });f.completeMain({});f.journal.claimStage(f.binding, "validation");const pinned = f.output({}, "validation");
  if (cause === "stop") f.journal.cancel(f.binding);else f.expire();
  const receipt = await f.recover();
  expect(receipt).toMatchObject({ outcome: cause === "stop" ? "cancelled" : "timed-out", physical_state: "ceased", validation: "failed" });
  expect(f.journal.retainedStageOutput(f.binding, "validation")).toEqual(pinned);
});

it("preserves execution output retained before its missing stage receipt when logical JSON is unreadable", async () => {
  const f = await fixture({ unreadable: true }), pinned = f.output({ retained: true });
  const receipt = await f.recover();
  expect(receipt).toMatchObject({ outcome: "uncertain", physical_state: "ceased", effect_certainty: "uncertain", output: pinned });
  expect(f.journal.stageReceipts(f.binding)).toMatchObject([{ stage: "execution", state: "unknown", result: pinned }]);
});

it("classifies malformed JSON text as known validation failure after independent aggregate cessation", async () => {
  const f = await fixture({ schema: { type: "object" }, result: "not valid JSON" });
  const receipt = await f.recover();
  expect(receipt).toMatchObject({ outcome: "failed", physical_state: "ceased", effect_certainty: "known", validation: "failed" });
  expect(receipt.validation_failures?.length).toBeGreaterThan(0);
});

it("retains an existing uncertain execution stage instead of upgrading it from a later successful logical row", async () => {
  const f = await fixture(), at = Date.now();
  f.journal.completeStage(f.binding, { stage: "execution", effect_key: f.key, attempt_id: f.binding.attempt_id,
    state: "unknown", started_at: at, completed_at: at, result: null }, "ceased");
  const before = f.journal.stageReceipts(f.binding);
  expect(await f.recover()).toMatchObject({ outcome: "uncertain", physical_state: "ceased", effect_certainty: "uncertain" });
  expect(f.journal.stageReceipts(f.binding)).toEqual(before);
});

it("rechecks every segment after input fencing and holds occupancy for a newly claimed unknown successor", async () => {
  const f = await fixture({ logicalRunning: true }), originalFence = f.session.fenceInput;
  let inserted = false;
  f.session.fenceInput = vi.fn(async () => {
    if (!inserted) {
      inserted = true;
      const own = f.destination.turns(f.declaration.bindingKey);
      const checkpoint = { format: "synthetic.race", version: 1, adapterId: "pi", adapterVersion: "1", harnessVersion: "1", configFingerprint: "original", payload: {} };
      const paused = own.pause(f.declaration.sessionId, f.admitted.turn.id, "original-owner", checkpoint, [{ id: "call", tool: "fixture:effect", input: {} }]);
      own.released(f.declaration.sessionId, f.admitted.turn.id, "original-owner");
      const next = own.resolve({ sessionId: f.declaration.sessionId, turnId: f.admitted.turn.id, requestId: "synthetic-race", runId: "new-unknown-segment", actor: "reviewer",
        decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
      expect(f.destination.claim(f.declaration.sessionId, f.admitted.turn.id, next.runId, "successor-owner")).toBe(true);
    }
    return originalFence();
  });
  f.supervisor.recoverReceipt(f.binding);
  await expect.poll(() => f.destination.settlements(f.admitted.turn.id).length).toBe(2);
  expect(f.journal.receipt(f.binding)).toBeNull();expect(f.supervisor.occupiedCount()).toBeGreaterThan(0);
  f.destination.notStarted("new-unknown-segment", "successor-owner");
  expect(await f.recover()).toMatchObject({ outcome: "uncertain", physical_state: "ceased" });
});
