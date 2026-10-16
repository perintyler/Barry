import { expect, it } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { workflowAgentRecovery } from "../../test/fixtures/workflow-agent-recovery.js";

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0);return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; }
}
async function closePreserving(f: Awaited<ReturnType<typeof workflowAgentRecovery>>, primary: unknown, expectUnsettled = false): Promise<void> {
  try { await f.close({ expectUnsettled }); }
  catch (cleanup) { if (primary !== undefined) throw new AggregateError([primary, cleanup], "Recovery assertion and owned fixture cleanup failed; retained " + f.root);throw cleanup; }
  if (primary !== undefined) throw primary;
}
async function killAfterSpool(f: Awaited<ReturnType<typeof workflowAgentRecovery>>) {
  const parent = await f.startParent();
  await expect.poll(() => f.marker(), { timeout: 20000 }).toBeDefined();
  const marker = f.marker()!;
  const fence = f.backend.destination.settlements(marker.binding.turnId).find(row => row.segmentId === marker.binding.segmentId)!;
  expect(fence.phase).toBe("input");expect(fence.ownerProcess?.pid).toBe(parent.child.pid);
  const pgid = (fence.handle as { pgid: number }).pgid;
  expect(groupExists(pgid)).toBe(true);
  // A valid committed spool is insufficient while its actual owner is alive.
  expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 0 });
  expect(parent.child.kill("SIGKILL")).toBe(true);await parent.closed;
  await expect.poll(() => groupExists(pgid), { timeout: 12000 }).toBe(false);
  await f.markUncertain();f.reopen();
  return marker;
}

it("repairs a real committed Pi result after owner SIGKILL and recovers the existing uncertain outer turn without repeating its native effect", async () => {
  const f = await workflowAgentRecovery({ outcomeGate: "completed" });
  let primary: unknown;
  try {
    await killAfterSpool(f);
    expect(await f.turns.inspect(f.key)).toMatchObject({ state: "uncertain" });
    expect(f.requests).toHaveLength(2);expect(f.providerErrors).toEqual([]);
    expect(readFileSync(join(f.root, "native-effect.txt"), "utf8")).toBe(f.toolContent);
    const effectTime = statSync(join(f.root, "native-effect.txt")).mtimeMs;
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toEqual({ state: "complete", result: f.finalResult });
    const completed = f.outcomes().find(row => row.outcome?.type === "completed")!;
    unlinkSync(join(completed.directory, "result.json"));
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toEqual({ state: "complete", result: f.finalResult });
    expect(await f.start()).toBe(f.finalResult);
    f.reopen();expect(await f.start()).toBe(f.finalResult);
    expect(await f.turns.inspect(f.key)).toMatchObject({ state: "complete" });
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT call_id,state FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "completed" }]);
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(0);
    expect(statSync(join(f.root, "native-effect.txt")).mtimeMs).toBe(effectTime);
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);

it("imports an actual lost Pi checkpoint as waiting without approving, relaunching, resending input or executing its proposal", async () => {
  const f = await workflowAgentRecovery({ outcomeGate: "interrupted" });
  let primary: unknown;
  try {
    const marker = await killAfterSpool(f);
    expect(marker.type).toBe("interrupted");
    const retained = f.outcomes().find(row => row.binding.segmentId === marker.binding.segmentId)!.outcome!;
    expect(retained.type).toBe("interrupted");
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toEqual({ state: "active" });
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.turns(f.declaration.bindingKey).snapshot(f.declaration.sessionId, mapping.turnId)).toMatchObject({ state: "waiting_for_input" });
    expect(f.db.prepare("SELECT owner FROM session_turns WHERE id=?").get(mapping.turnId)).toEqual({ owner: null });
    if (retained.type === "interrupted") {
      const row = f.db.prepare("SELECT continuation_json FROM session_turns WHERE id=?").get(mapping.turnId) as { continuation_json: string };
      expect(JSON.parse(row.continuation_json)).toEqual(retained.continuation);
    }
    expect(f.db.prepare("SELECT call_id,status FROM session_interrupts").all()).toEqual([{ call_id: f.callId, status: "pending" }]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_call_outcomes").get()).toEqual({ n: 0 });
    const imported = f.outcomes().find(row => row.binding.segmentId === marker.binding.segmentId)!;
    writeFileSync(join(imported.directory, "result.json"), "{malformed after import", { mode: 0o600 });
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toEqual({ state: "active" });
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    f.reopen();await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(0);
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 1 });
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);

it("uses the actual committed spool after same-process worker IPC loss without sending a second input or replaying the native write", async () => {
  const f = await workflowAgentRecovery({ outcomeGate: "completed", disconnectReply: true });
  let primary: unknown;
  try {
    expect(await f.start()).toBe(f.finalResult);
    expect(f.marker()?.type).toBe("completed");
    expect(readFileSync(join(f.root, "native-effect.txt"), "utf8")).toBe(f.toolContent);
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(2);
    expect(f.backend.destination.unsettled()).toEqual([]);
    const effectTime = statSync(join(f.root, "native-effect.txt")).mtimeMs;
    f.reopen();expect(await f.start()).toBe(f.finalResult);
    expect(f.requests).toHaveLength(2);
    expect(statSync(join(f.root, "native-effect.txt")).mtimeMs).toBe(effectTime);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_call_outcomes").get()).toEqual({ n: 1 });
    expect(f.providerErrors).toEqual([]);
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);

it.each(["missing", "malformed"] as const)("physically settles the dead owner when its committed result spool becomes %s without inventing an outcome or relaunching", async corruption => {
  const f = await workflowAgentRecovery({ outcomeGate: "completed" });
  let primary: unknown;
  try {
    const marker = await killAfterSpool(f);
    const entry = f.outcomes().find(row => row.binding.segmentId === marker.binding.segmentId)!;
    const resultPath = join(entry.directory, "result.json");
    if (corruption === "missing") unlinkSync(resultPath);else writeFileSync(resultPath, "{malformed", { mode: 0o600 });
    if (corruption === "malformed") await expect(f.backend.lookupTurn(f.declaration.sessionId, f.key)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    else expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 0 });
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(0);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_call_outcomes").get()).toEqual({ n: 1 });
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);

it("does not autoapprove a real interrupted outcome when its worker reply is lost under automatic policy", async () => {
  const f = await workflowAgentRecovery({ outcomeGate: "interrupted", disconnectReply: true });
  let primary: unknown;
  try {
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.marker()?.type).toBe("interrupted");expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(1);
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_call_outcomes").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_run_segments").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT state FROM session_turns").all()).toEqual([{ state: "recovery_required" }]);
    expect(f.backend.destination.unsettled()).toEqual([]);
    f.reopen();await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(1);
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);
