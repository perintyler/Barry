/** Conservative observer branches use mocked OS observations, not native cessation evidence. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import type { WorkflowDestinationBinding, WorkflowSettlement } from "@barry-rocks/sessions-bag/store/workflow-destinations";
const observations = vi.hoisted(() => ({ ps: vi.fn(), host: vi.fn(), boot: vi.fn(), current: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: observations.ps }));
vi.mock("node:os", () => ({ hostname: observations.host }));
vi.mock("@barry-rocks/sdk/internal/workflows", () => ({ processBootIdentity: observations.boot, isCurrentProcessBootIdentity: observations.current }));
import { observeWorkflowPhysicalRecovery, workflowProcessOwnerIdentity } from "./workflow-process-recovery.js";

const ownerPid = 12345, guardianPid = 23456;
const started = Date.parse("Wed Oct 14 16:00:00 2026 UTC") / 1000;
const ownerProcess = { pid: ownerPid, pid_started_at: started, hostname: "mock-host", bootIdentity: "mock-boot", startIdentity: "ps_utc_v1" as const };
const evidence = { identity: "mock-identity", traits: [], bound: null, tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const declaration: WorkflowDestinationBinding = { bindingKey: "mock/binding", sessionId: "mock-session", identity: "mock-identity", identityId: 42, actorId: 1, scope,
  selection: { harness: "pi", model: "mock/model", endpoint: "http://mock.invalid", cwd: "/mock", maxTurns: 2, deadline: 2000000000000 } };
function input() {
  const handle = { kind: "process", pid: guardianPid, pgid: guardianPid, pidStartedAt: started + 1, hostname: "mock-host", bootIdentity: "mock-boot", sessionId: declaration.sessionId, turnId: "turn", segmentId: "segment" };
  const fence: WorkflowSettlement = { segmentId: "segment", sessionId: declaration.sessionId, turnId: "turn", owner: "original-owner", phase: "input", ownerProcess, handle, inputAt: "2026-10-14T16:00:01Z", closingAt: null, ceasedAt: null };
  return { declaration, key: "mock/turn", fence, originalIntentHash: "a".repeat(64), revision: 7 };
}
const presence = new Map<number, "present" | "EPERM">();
beforeEach(() => {
  presence.clear();observations.host.mockReturnValue("mock-host");observations.boot.mockReturnValue("mock-boot");observations.current.mockImplementation((retained: unknown) => retained === observations.boot());
  observations.ps.mockReturnValue({ status: 0, stdout: "Wed Oct 14 16:00:00 2026\n" });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(signal).toBe(0);
    const state = presence.get(pid);if (state === "present") return true;
    throw Object.assign(new Error("Mock native observation"), { code: state ?? "ESRCH" });
  });
});
afterEach(() => { vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs(); });

it("binds a proof to exact owner, handle, scope and selection when mocked owner/PID/group observations are absent", () => {
  const original = input(), proof = observeWorkflowPhysicalRecovery(original);
  expect(proof).toMatchObject({ version: 1, ownerDead: true, groupAbsent: true, handleHash: boundFingerprint(original.fence.handle), ownerProcessHash: boundFingerprint(ownerProcess), scopeHash: boundFingerprint(scope), selectionHash: boundFingerprint(declaration.selection) });
  expect(proof).toMatchObject({ originalIntentHash: "a".repeat(64), revision: 7 });expect(proof).not.toHaveProperty("outcomeHash");
  expect(process.kill).toHaveBeenCalledTimes(3);expect(observations.ps).not.toHaveBeenCalled();
});

it.each([ownerPid, guardianPid, -guardianPid])("retains uncertainty on EPERM observing PID/group %s", pid => {
  presence.set(pid, "EPERM");expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();
});

it.each([guardianPid, -guardianPid])("retains uncertainty while captured native PID/group %s is present", pid => {
  presence.set(pid, "present");expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();
});

it("refuses a live original owner with matching start identity", () => {
  presence.set(ownerPid, "present");expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();
  expect(observations.ps).toHaveBeenCalledWith("/bin/ps", ["-o", "lstart=", "-p", String(ownerPid)], expect.objectContaining({ timeout: 1000 }));
  expect(process.kill).toHaveBeenCalledTimes(1);
});

it.each(["missing", "failed", "invalid"] as const)("refuses an existing owner PID with %s start observation", mode => {
  presence.set(ownerPid, "present");observations.ps.mockReturnValue(mode === "failed" ? { status: 1, stdout: "" } : { status: 0, stdout: mode === "invalid" ? "invalid" : "" });
  expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();expect(process.kill).toHaveBeenCalledTimes(1);
});

it("accepts known different owner start only with independently absent guardian PID and entire group", () => {
  presence.set(ownerPid, "present");observations.ps.mockReturnValue({ status: 0, stdout: "Wed Oct 14 16:00:02 2026\n" });
  expect(observeWorkflowPhysicalRecovery(input())).toMatchObject({ ownerDead: true, groupAbsent: true });
  presence.set(-guardianPid, "present");expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();
  // This is an observation-branch test, not a real PID-reuse experiment.
});

it.each(["host", "boot"] as const)("refuses another %s before making any native PID observation", mismatch => {
  if (mismatch === "host") observations.host.mockReturnValue("another-host");else observations.boot.mockReturnValue("another-boot");
  expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();expect(process.kill).not.toHaveBeenCalled();
});

it("refuses legacy missing owner identity without observing or signalling a PID", () => {
  const original = input();original.fence.ownerProcess = null;
  expect(observeWorkflowPhysicalRecovery(original)).toBeUndefined();expect(process.kill).not.toHaveBeenCalled();
});

it("captures the same UTC native owner across caller timezones and never mistakes that still-live owner for a recycled PID", () => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
  const first = workflowProcessOwnerIdentity();
  vi.stubEnv("TZ", "Asia/Tokyo");
  const second = workflowProcessOwnerIdentity();
  expect(first).toEqual({ ...ownerProcess, pid: process.pid });expect(second).toEqual(first);
  expect(observations.ps).toHaveBeenCalledWith("/bin/ps", expect.any(Array), expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }));
  presence.set(ownerPid, "present");
  expect(observeWorkflowPhysicalRecovery(input())).toBeUndefined();
});

it("refuses a present legacy owner without a tagged UTC start even if its ambiguous start appears different", () => {
  const original = input(), { startIdentity: _tag, ...legacy } = ownerProcess;
  original.fence.ownerProcess = legacy;
  presence.set(ownerPid, "present");observations.ps.mockReturnValue({ status: 0, stdout: "Wed Oct 14 16:00:02 2026\n" });
  expect(observeWorkflowPhysicalRecovery(original)).toBeUndefined();expect(observations.ps).not.toHaveBeenCalled();
  presence.clear();expect(observeWorkflowPhysicalRecovery(original)).toMatchObject({ ownerDead: true, groupAbsent: true });
});

it("preserves an accepted legacy boot identity in the proof instead of silently rebinding it to the new canonical identity", () => {
  const original = input(), legacy = "b".repeat(64);
  original.fence.ownerProcess = { ...ownerProcess, bootIdentity: legacy };
  const handle = original.fence.handle;if (!handle || typeof handle !== "object") throw new Error("Expected fixture handle");
  original.fence.handle = { ...handle, bootIdentity: legacy };
  observations.current.mockImplementation((retained: unknown) => retained === legacy);
  expect(observeWorkflowPhysicalRecovery(original)).toMatchObject({ bootIdentity: legacy, ownerDead: true, groupAbsent: true });
  expect(observations.current).toHaveBeenCalledWith(legacy);
});
