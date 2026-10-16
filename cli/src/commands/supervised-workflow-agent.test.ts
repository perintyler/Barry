import { expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { supervisedWorkflowAgent } from "../../test/fixtures/supervised-workflow-agent.js";

function groupExists(pgid: number): boolean { try { process.kill(-pgid, 0);return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; } }

it("runs an actual Pi native write through a committed checkpoint, fresh supervised segment and durable parent effect gate exactly once", async () => {
  const f = await supervisedWorkflowAgent();
  try {
    expect(f.launches).toHaveLength(0);expect(f.requests).toHaveLength(0);
    expect(await f.start()).toBe(f.finalResult);
    expect(readFileSync(join(f.root, "native-effect.txt"), "utf8")).toBe(f.toolContent);
    const effectStat = statSync(join(f.root, "native-effect.txt"));
    expect(f.requests).toHaveLength(2);expect(f.requests.every(request => request.phase === "input" && request.authorization === "Bearer supervised-local-key")).toBe(true);
    const second = f.requests[1].body as { messages: { role: string; tool_call_id?: string; content?: unknown }[] };
    expect(second.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual([f.callId]);
    expect(JSON.stringify(second.messages).split("one original supervised request")).toHaveLength(2);
    expect(f.launches).toHaveLength(2);expect(f.configured).toHaveLength(2);
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.settlements(mapping.turnId)).toHaveLength(2);
    expect(f.backend.destination.settlements(mapping.turnId).every(row => row.phase === "ceased")).toBe(true);
    expect(f.db.prepare("SELECT call_id,state FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "completed" }]);
    expect(f.db.prepare("SELECT call_id,status FROM session_interrupts").all()).toEqual([{ call_id: f.callId, status: "approved" }]);
    expect(f.db.prepare("SELECT state FROM session_run_segments ORDER BY created_at,rowid").all()).toEqual([{ state: "interrupted" }, { state: "completed" }]);
    expect(f.providerErrors).toEqual([]);
    const outcomes = f.outcomes();expect(outcomes).toHaveLength(2);
    expect(outcomes.map(entry => entry.outcome?.type).sort()).toEqual(["completed", "interrupted"]);
    for (const entry of outcomes) {
      expect(entry.binding.sessionId).toBe(f.declaration.sessionId);
      const fence = f.backend.destination.settlements(mapping.turnId).find(row => row.segmentId === entry.binding.segmentId)!;
      expect(groupExists((fence.handle as { pgid: number }).pgid)).toBe(false);
    }
    expect(await f.start()).toBe(f.finalResult);f.reopen();expect(await f.start()).toBe(f.finalResult);
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(2);
    expect(statSync(join(f.root, "native-effect.txt")).mtimeMs).toBe(effectStat.mtimeMs);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM session_call_outcomes").get()).toEqual({ count: 1 });
  } catch (error) {
    throw new Error(`Supervised native diagnostics: ${JSON.stringify({ requests: f.requests, providerErrors: f.providerErrors, settlements: f.db.prepare("SELECT * FROM session_workflow_settlements").all(), outcomes: f.db.prepare("SELECT * FROM session_call_outcomes").all() })}`, { cause: error });
  } finally { await f.close(); }
}, 60000);

it("uses the original guardian deadline to cease a real blocked Pi provider request without inventing a completed outcome", async () => {
  const f = await supervisedWorkflowAgent({ mode: "blocked", deadlineMs: 5000 });
  try {
    const operation = f.start().then(() => null, error => error);
    await f.requested;
    expect(f.requests).toHaveLength(1);expect(f.requests[0].phase).toBe("input");
    const handle = f.requests[0].handle as { pgid: number };
    expect(groupExists(handle.pgid)).toBe(true);
    expect(await operation).toBeInstanceOf(SessionReconciliationRequired);
    expect(Date.now()).toBeGreaterThanOrEqual(f.declaration.selection.deadline);
    await expect.poll(() => groupExists(handle.pgid), { timeout: 8000 }).toBe(false);
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
    expect(f.outcomes().every(entry => entry.outcome?.type !== "completed")).toBe(true);
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
  } finally { await f.close(); }
}, 60000);

it("survives real backend parent SIGKILL with autonomous guardian cessation and conservatively held reconstructed fences without relaunch", async () => {
  const f = await supervisedWorkflowAgent({ mode: "blocked" });
  let killed = false;
  try {
    const parent = await f.startParent();await Promise.race([f.requested, parent.failed]);
    const handle = f.requests[0].handle as { pgid: number };
    expect(groupExists(handle.pgid)).toBe(true);
    expect(parent.child.kill("SIGKILL")).toBe(true);await parent.closed;killed = true;
    // Observe production guardian behavior before fixture cleanup or DB reopen.
    await expect.poll(() => groupExists(handle.pgid), { timeout: 12000 }).toBe(false);
    f.reopen();
    expect(f.backend.destination.unsettled()).toMatchObject([{ phase: "input", ceasedAt: null }]);
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(0);
    expect(f.outcomes().every(entry => entry.outcome === undefined)).toBe(true);
  } finally { await f.close({ expectUnsettled: killed }); }
}, 60000);

it("refuses completion after an actual result-spool filesystem failure and never repeats the provider request on duplicate or reconstruction", async () => {
  const f = await supervisedWorkflowAgent({ mode: "spool-failure" });
  try {
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);
    // The obstruction is a real directory at the production result pathname,
    // not a forged outcome. Remove it only after the failed child has ceased.
    const fences = f.backend.destination.settlements(f.backend.destination.inspect(f.key)!.turnId);
    expect(fences.every(row => row.phase === "ceased")).toBe(true);
    f.clearSpoolObstruction();expect(f.outcomes().map(entry => entry.outcome)).toEqual([undefined]);
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    f.reopen();await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(1);expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
  } finally { await f.close(); }
}, 60000);


it("rechecks trusted current authority after actual worker readiness before activation, credentials or input are released", async () => {
  const f = await supervisedWorkflowAgent({ bootstrapGate: true });
  try {
    const operation = f.start().then(() => null, error => error);
    await expect.poll(() => existsSync(join(f.root, "bootstrap-wait.json"))).toBe(true);
    expect(f.configured).toHaveLength(1);expect(f.requests).toHaveLength(0);
    const before = f.backend.destination.unsettled();
    expect(before).toMatchObject([{ phase: "handled", inputAt: null }]);
    const handle = before[0].handle as { pgid: number };
    expect(groupExists(handle.pgid)).toBe(true);
    f.revoke();f.releaseBootstrap();
    expect(await operation).toBeInstanceOf(SessionReconciliationRequired);
    expect(f.driverPolicyChecks.at(-1)).toBe(false);expect(f.policyChecks.at(-1)).toBe(false);expect(f.requests).toHaveLength(0);
    expect(f.db.prepare("SELECT input_at FROM session_workflow_settlements").all()).toEqual([{ input_at: null }]);
    expect(groupExists(handle.pgid)).toBe(false);expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.outcomes().map(entry => entry.outcome)).toEqual([undefined]);
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
  } finally { f.releaseBootstrap();await f.close(); }
}, 60000);
