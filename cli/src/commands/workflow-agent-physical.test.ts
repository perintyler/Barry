/** Actual native evidence, trusted fixture authority; no host resource-broker claim. */
import { expect, it } from "vitest";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { prepareOwnedProcess, processBootIdentity, isCurrentProcessBootIdentity } from "@barry-rocks/sdk/internal/workflows";
import { workflowProcessOwnerIdentity, observeWorkflowPhysicalRecovery } from "../../../bags/sessions/api/src/workflow-process-recovery.js";
import type { WorkflowDestinationBinding, WorkflowSettlement } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { workflowAgentPhysical } from "../../test/fixtures/workflow-agent-physical.js";

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0);return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; }
}
async function closePreserving(f: Awaited<ReturnType<typeof workflowAgentPhysical>>, primary: unknown): Promise<void> {
  try { await f.close(); }
  catch (cleanup) { if (primary !== undefined) throw new AggregateError([primary, cleanup], "Physical assertion and cleanup failed; retained " + f.root);throw cleanup; }
  if (primary !== undefined) throw primary;
}
function logicalImage(f: Awaited<ReturnType<typeof workflowAgentPhysical>>) {
  return JSON.stringify({ turns: f.db.prepare("SELECT * FROM session_turns").all(), segments: f.db.prepare("SELECT * FROM session_run_segments").all(), effects: f.db.prepare("SELECT * FROM session_call_outcomes").all(), interrupts: f.db.prepare("SELECT * FROM session_interrupts").all(), events: f.db.prepare("SELECT * FROM session_execution_events").all() });
}

it.each(["missing", "malformed", "cancelled", "raw-result"] as const)("records physical-only cessation after actual owner death with %s output/intent while preserving original logical state and effect", async disposition => {
  const f = await workflowAgentPhysical({ outcomeGate: "completed" });
  let primary: unknown;
  try {
    const parent = await f.startParent();
    await expect.poll(() => f.marker(), { timeout: 20000 }).toBeDefined();
    const marker = f.marker()!, fence = f.backend.destination.settlements(marker.binding.turnId).find(row => row.segmentId === marker.binding.segmentId)!;
    const pgid = (fence.handle as { pgid: number }).pgid;
    expect(fence.ownerProcess?.pid).toBe(parent.child.pid);expect(groupExists(pgid)).toBe(true);
    const entry = f.outcomes().find(row => row.binding.segmentId === marker.binding.segmentId)!;
    const pathname = join(entry.directory, "result.json");
    // Damage the committed outcome before lookup; physical recovery must not
    // need it, and the live original owner must still fence physical settlement.
    if (disposition === "malformed") writeFileSync(pathname, "{malformed", { mode: 0o600 });else if (disposition !== "raw-result") unlinkSync(pathname);
    if (disposition === "malformed") await expect(f.backend.lookupTurn(f.declaration.sessionId, f.key)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    else expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).not.toMatchObject({ state: "complete" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 0 });
    expect(f.backend.destination.unsettled()).toMatchObject([{ segmentId: marker.binding.segmentId, phase: "input" }]);
    expect(parent.child.kill("SIGKILL")).toBe(true);await parent.closed;
    await expect.poll(() => groupExists(pgid), { timeout: 12000 }).toBe(false);
    await f.markUncertain();f.reopen();
    if (disposition === "cancelled") f.backend.destination.cancel(f.key);
    if (disposition === "raw-result") f.db.prepare("UPDATE session_turns SET result_json='{malformed persisted result' WHERE id=?").run(marker.binding.turnId);
    const before = logicalImage(f), effectTime = statSync(join(f.root, "native-effect.txt")).mtimeMs;
    if (disposition === "malformed" || disposition === "raw-result") await expect(f.backend.lookupTurn(f.declaration.sessionId, f.key)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    else expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toMatchObject({ state: disposition === "cancelled" ? "interrupted" : "uncertain" });
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.backend.destination.settlements(marker.binding.turnId).find(row => row.segmentId === marker.binding.segmentId)).toMatchObject({ phase: "ceased", ceasedAt: expect.any(String) });
    expect(logicalImage(f)).toBe(before);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
    expect(f.backend.destination.cancelled(f.key)).toBe(disposition === "cancelled");
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    f.reopen();await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(0);expect(f.providerErrors).toEqual([]);
    expect(readFileSync(join(f.root, "native-effect.txt"), "utf8")).toBe(f.toolContent);
    expect(statSync(join(f.root, "native-effect.txt")).mtimeMs).toBe(effectTime);
    expect(f.db.prepare("SELECT call_id,state FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "completed" }]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);

it("refuses physical recovery across a real caller timezone change while the captured owner remains alive even after its actual guardian group is absent", async () => {
  const previousTZ = process.env.TZ;
  let owned: Awaited<ReturnType<typeof prepareOwnedProcess>> | undefined, primary: unknown;
  try {
    process.env.TZ = "Pacific/Honolulu";
    const ownerProcess = workflowProcessOwnerIdentity();
    if (!ownerProcess) throw new Error("Actual UTC native owner capture unavailable");
    expect(ownerProcess.startIdentity).toBe("ps_utc_v1");expect(ownerProcess.pid).toBe(process.pid);
    const capturedBoot = processBootIdentity();expect(ownerProcess.bootIdentity).toBe(capturedBoot);
    if (process.platform === "darwin") expect(capturedBoot).toMatch(/^darwin:boottime:v1:[1-9][0-9]*:[0-9]+$/);
    owned = await prepareOwnedProcess({ deadline: Date.now() + 15000 });
    const handle = { ...owned.handle, sessionId: "native-tz-session", turnId: "native-tz-turn", segmentId: "native-tz-segment" };
    await owned.dispose();expect(groupExists(handle.pgid)).toBe(false);
    const evidence = { identity: "trusted-native-tz-identity", traits: [], bound: null, tools: {} };
    const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
    const declaration: WorkflowDestinationBinding = { bindingKey: "native-tz-binding", sessionId: handle.sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
      selection: { harness: "pi", model: "native-tz/model", endpoint: "http://fixture.invalid", cwd: "/fixture", maxTurns: 1, deadline: Date.now() + 15000 } };
    const fence: WorkflowSettlement = { segmentId: handle.segmentId, sessionId: handle.sessionId, turnId: handle.turnId, owner: "trusted-native-tz-owner", phase: "handled", ownerProcess, handle, inputAt: null, closingAt: null, ceasedAt: null };
    process.env.TZ = "Asia/Tokyo";
    expect(processBootIdentity()).toBe(capturedBoot);expect(handle.bootIdentity).toBe(capturedBoot);
    expect(isCurrentProcessBootIdentity(ownerProcess.bootIdentity)).toBe(true);
    expect(isCurrentProcessBootIdentity(handle.bootIdentity)).toBe(true);
    expect(process.kill(ownerProcess.pid, 0)).toBe(true);
    expect(observeWorkflowPhysicalRecovery({ declaration, key: "native-tz-key", fence, originalIntentHash: "a".repeat(64), revision: 1 })).toBeUndefined();
    if (process.platform === "darwin") {
      const actualLegacyUtc = boundFingerprint(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).trim());
      expect(actualLegacyUtc).toMatch(/^[a-f0-9]{64}$/);expect(isCurrentProcessBootIdentity(actualLegacyUtc)).toBe(true);
      expect(isCurrentProcessBootIdentity("0".repeat(64))).toBe(false);
    }
    // Only the native observer is exercised here. No store receipt, grant or
    // resource settlement is fabricated from this trusted declaration.
  } catch (error) { primary = error; }
  finally {
    try { await owned?.dispose(); }
    catch (cleanup) { primary = primary === undefined ? cleanup : new AggregateError([primary, cleanup], "Native timezone assertion and guardian cleanup failed"); }
    if (previousTZ === undefined) delete process.env.TZ;else process.env.TZ = previousTZ;
  }
  if (primary !== undefined) throw primary;
}, 15000);

it("settles actual native cessation while preserving the real parent's executing effect journal and never invoking the held Pi write closure", async () => {
  const f = await workflowAgentPhysical({ holdEffect: true });
  let primary: unknown;
  try {
    const parent = await f.startParent();
    await expect.poll(() => f.effectMarker(), { timeout: 20000 }).toBeDefined();
    const marker = f.effectMarker()!, fence = f.backend.destination.settlements(marker.binding.turnId).find(row => row.segmentId === marker.binding.segmentId)!;
    const pgid = (fence.handle as { pgid: number }).pgid;
    expect(fence.ownerProcess?.pid).toBe(parent.child.pid);expect(groupExists(pgid)).toBe(true);
    expect(f.db.prepare("SELECT call_id,state,outcome_json FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "executing", outcome_json: null }]);
    expect(f.requests).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 0 });
    expect(parent.child.kill("SIGKILL")).toBe(true);await parent.closed;
    await expect.poll(() => groupExists(pgid), { timeout: 12000 }).toBe(false);
    await f.markUncertain();f.reopen();const before = logicalImage(f);
    expect(await f.backend.lookupTurn(f.declaration.sessionId, f.key)).toEqual({ state: "uncertain" });
    expect(f.backend.destination.unsettled()).toEqual([]);expect(logicalImage(f)).toBe(before);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_physical_settlements").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_workflow_outcome_recoveries").get()).toEqual({ n: 0 });
    await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    f.reopen();await expect(f.start()).rejects.toBeInstanceOf(SessionReconciliationRequired);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(0);expect(f.providerErrors).toEqual([]);
    expect(f.db.prepare("SELECT call_id,state,outcome_json FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "executing", outcome_json: null }]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_run_segments").get()).toEqual({ n: 2 });
    expect(() => readFileSync(join(f.root, "native-effect.txt"))).toThrow(/ENOENT/);
    expect(logicalImage(f)).toBe(before);
  } catch (error) { primary = error; } finally { await closePreserving(f, primary); }
}, 60000);
