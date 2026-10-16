import { expect, it } from "vitest";
import { SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { classify } from "@barry-rocks/sessions-bag/process-liveness";
import { workflowAgentDestination } from "../../test/fixtures/workflow-agent-process.js";

it("runs an actual full Pi turn only after durable native input binding and replays its exact retained result after SQLite reopen", async () => {
  const f = await workflowAgentDestination();
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    expect(id).toBe(f.declaration.sessionId);
    expect(sessionIdentity(id)).toBe(f.scope.identity);
    expect(f.counts.prepares).toBe(0);expect(f.requests).toHaveLength(0);
    const input = { text: "review-original" };
    expect(await f.turns.turn(f.key, id, input, f.scope)).toBe(f.resultText);
    expect(f.requests).toHaveLength(1);expect(f.requests[0].phase).toBe("input");
    expect(f.requests[0].authorization).toBe("Bearer local-fixture-key");
    expect(JSON.stringify(f.requests[0].body)).toContain(input.text);
    expect(f.counts).toEqual({ prepares: 1, activations: 1, acquired: 1, released: 1 });
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(await f.turns.turn(f.key, id, input, f.scope)).toBe(f.resultText);
    f.reopen();
    expect(await f.turns.ensure(f.bindingKey, f.scope)).toBe(id);
    expect(await f.turns.turn(f.key, id, input, f.scope)).toBe(f.resultText);
    expect(f.requests).toHaveLength(1);expect(f.counts.prepares).toBe(1);
    const child = f.children[0];
    expect(classify({ pid: child.pid, pid_started_at: Number(child.handle.pidStartedAt), hostname: child.handle.hostname }).state).toBe("dead");
  } catch (error) {
    throw new Error(`Actual destination diagnostics: ${JSON.stringify({
      turns: f.db.prepare("SELECT id,state,error,result_json FROM session_turns").all(),
      settlements: f.db.prepare("SELECT phase,handle_json,input_at,closing_at,ceased_at FROM session_workflow_settlements").all(),
      counts: f.counts, providerRequests: f.requests,
    })}`, { cause: error });
  } finally { await f.close(); }
}, 60_000);

it("keeps a real logically completed Pi result uncertain while its child close is gated and releases capacity only after exact native cessation", async () => {
  const f = await workflowAgentDestination({ holdClose: true });
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    const operation = f.turns.turn(f.key, id, { text: "close-gated-original" }, f.scope);
    let settled = false;void operation.then(() => { settled = true; }, () => { settled = true; });
    await f.closing;
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.turns(f.bindingKey).snapshot(id, mapping.turnId)).toMatchObject({ state: "completed", result: f.resultText });
    expect(f.children[0].done()).toBe(false);
    expect(await f.backend.lookupTurn(id, f.key)).toEqual({ state: "uncertain" });
    expect(f.backend.destination.unsettled()).toMatchObject([{ phase: "closing", inputAt: expect.any(String), ceasedAt: null }]);
    expect(settled).toBe(false);expect(f.counts.released).toBe(0);
    await expect(f.turns.turn(f.key + "/other", id, { text: "must-not-send" }, f.scope)).rejects.toThrow("SessionBusy");
    expect(f.requests).toHaveLength(1);
    f.releaseClose();expect(await operation).toBe(f.resultText);
    expect(f.children[0].done()).toBe(true);expect(f.counts.released).toBe(1);
    expect(await f.backend.lookupTurn(id, f.key)).toEqual({ state: "complete", result: f.resultText });
  } finally { await f.close(); }
}, 60_000);

it("recovers an actual completed destination result after outer journal acknowledgement commit fails without another Pi prompt", async () => {
  const f = await workflowAgentDestination();
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    f.db.exec("CREATE TRIGGER lose_workflow_receipt BEFORE UPDATE OF state ON session_workflow_turns WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'lost outer receipt commit'); END");
    await expect(f.turns.turn(f.key, id, { text: "lost-reply-original" }, f.scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);
    expect(await f.backend.lookupTurn(id, f.key)).toEqual({ state: "complete", result: f.resultText });
    f.db.exec("DROP TRIGGER lose_workflow_receipt");f.reopen();
    expect(await f.turns.turn(f.key, id, { text: "lost-reply-original" }, f.scope)).toBe(f.resultText);
    expect(f.requests).toHaveLength(1);expect(f.counts.prepares).toBe(1);
    expect(await f.turns.inspect(f.key)).toMatchObject({ state: "complete" });
  } finally { await f.close(); }
}, 60_000);

it("does not relaunch after backend reconstruction when cessation proof for an actually exited child is unavailable", async () => {
  const f = await workflowAgentDestination({ proofUnavailable: true });
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    await expect(f.turns.turn(f.key, id, { text: "retain-uncertainty" }, f.scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.children[0].done()).toBe(true);expect(f.requests).toHaveLength(1);
    expect(f.backend.destination.unsettled()).toMatchObject([{ phase: "closing", ceasedAt: null }]);
    // Reconstruction is a real SQLite reopen; this case conservatively withholds
    // independent proof, rather than claiming to have killed an API process.
    f.reopen();
    expect(await f.backend.lookupTurn(id, f.key)).toEqual({ state: "uncertain" });
    await expect(f.turns.turn(f.key, id, { text: "retain-uncertainty" }, f.scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    await expect(f.turns.turn(f.key + "/other", id, { text: "must-not-start" }, f.scope)).rejects.toThrow("SessionBusy");
    expect(f.requests).toHaveLength(1);expect(f.counts.prepares).toBe(1);
    await expect(f.backend.close()).rejects.toThrow("Workflow harness cleanup remains uncertain");
  } finally { await f.close({ expectUnsettled: true }); }
}, 60_000);


it("rejects a reconstructed destination selection change even when its real completed receipt exists", async () => {
  const f = await workflowAgentDestination();
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    expect(await f.turns.turn(f.key, id, { text: "immutable-selection" }, f.scope)).toBe(f.resultText);
    f.reopen({ ...f.declaration.selection, model: "openai/changed" });
    await expect(f.backend.lookupTurn(id, f.key)).rejects.toThrow("declaration conflict");
    await expect(f.turns.turn(f.key, id, { text: "immutable-selection" }, f.scope)).rejects.toThrow("declaration conflict");
    expect(f.requests).toHaveLength(1);expect(f.counts.prepares).toBe(1);
  } finally { await f.close(); }
}, 60_000);

it("reauthorizes the retained deadline after an asynchronous authority check before admitting or activating a turn", async () => {
  const f = await workflowAgentDestination({ deadlineMs: 1000 });
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope), authority = f.pauseAuthorization();
    const operation = f.turns.turn(f.key, id, { text: "expired-during-authorize" }, f.scope);
    const outcome = operation.then(() => null, error => error);
    await authority.entered;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, f.declaration.selection.deadline - Date.now()) + 10));
    authority.release();
    expect(await outcome).toBeInstanceOf(SessionReconciliationRequired);
    expect(f.backend.destination.inspect(f.key)).toBeUndefined();
    expect(f.counts.prepares).toBe(0);expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

it("disposes the actual inert child after durable handle publication fails without activating or releasing unknown capacity", async () => {
  const f = await workflowAgentDestination();
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    f.db.exec("CREATE TRIGGER fail_native_handle BEFORE UPDATE OF handle_json ON session_workflow_settlements WHEN NEW.handle_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture durable handle unavailable'); END");
    await expect(f.turns.turn(f.key, id, { text: "must-not-activate" }, f.scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.children).toHaveLength(1);expect(f.children[0].done()).toBe(true);
    expect(f.counts.activations).toBe(0);expect(f.counts.released).toBe(0);expect(f.requests).toHaveLength(0);
    expect(f.backend.destination.unsettled()).toMatchObject([{ phase: "preparing", handle: null }]);
    f.db.exec("DROP TRIGGER fail_native_handle");
    await f.backend.close();
    expect(f.backend.destination.unsettled()).toEqual([]);expect(f.counts.released).toBe(1);
  } finally { f.db.exec("DROP TRIGGER IF EXISTS fail_native_handle");await f.close(); }
}, 60_000);

it("records not-started physical settlement when cancellation wins while actual capacity acquisition is pending", async () => {
  const f = await workflowAgentDestination({ holdAcquire: true });
  try {
    const id = await f.turns.ensure(f.bindingKey, f.scope);
    const outcome = f.turns.turn(f.key, id, { text: "cancel-before-acquire" }, f.scope).then(() => null, error => error);
    await f.acquiring;
    const cancellation = f.backend.interruptTurn(id, f.key);
    expect(f.backend.destination.cancelled(f.key)).toBe(true);
    f.releaseAcquire();expect(await cancellation).toBe(true);
    expect(await outcome).toBeInstanceOf(SessionReconciliationRequired);
    const turn = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.settlements(turn.turnId)).toMatchObject([{ phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) }]);
    expect(f.counts).toEqual({ prepares: 0, activations: 0, acquired: 1, released: 1 });
    expect(f.requests).toHaveLength(0);expect(f.children).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);
