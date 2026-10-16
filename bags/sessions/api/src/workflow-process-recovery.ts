/** Read-only local observations for retained workflow results. Never signals or launches. */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { z } from "zod";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { processBootIdentity, isCurrentProcessBootIdentity } from "@barry-rocks/sdk/internal/workflows";
import { workflowOwnerProcessSchema, workflowRecoveryProofSchema, workflowPhysicalProofSchema, type WorkflowOwnerProcess, type WorkflowRecoveryProof, type WorkflowPhysicalProof, type WorkflowSettlement, type WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";

const handleSchema = z.strictObject({
  kind: z.literal("process"), pid: z.number().int().positive(), pgid: z.number().int().positive(),
  pidStartedAt: z.number().finite().positive(), hostname: z.string().min(1), bootIdentity: z.string().min(1),
  sessionId: z.string().min(1), turnId: z.string().min(1), segmentId: z.string().min(1),
});

function nativeStart(pid: number): number | undefined {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  const stamp = result.stdout.trim();
  if (!stamp) return undefined;
  const date = Date.parse(`${stamp} UTC`);
  return Number.isFinite(date) ? Math.floor(date / 1000) : undefined;
}

/** Unknown observation is deliberately distinct from absence. */
function absence(pid: number): "absent" | "present" | "unknown" {
  try { process.kill(pid, 0);return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
}

/** Capture at claim time. Never backfill a legacy fence with a later process. */
export function workflowProcessOwnerIdentity(): WorkflowOwnerProcess | undefined {
  try {
    const started = nativeStart(process.pid);
    if (started === undefined) return undefined;
    return workflowOwnerProcessSchema.parse({ pid: process.pid, pid_started_at: started, hostname: hostname(), bootIdentity: processBootIdentity(), startIdentity: "ps_utc_v1" });
  } catch { return undefined; }
}

/**
 * A successful result is not physical proof. Only a dead original local owner,
 * absent captured guardian PID and ESRCH for the entire captured group permit
 * this observation. A live/stopped/zombie owner, another boot/host, EPERM or
 * recycled/live guardian retains uncertainty. No recovered PID receives a signal.
 */
function observeWorkflowCessation(input: { declaration: WorkflowDestinationBinding; key: string; fence: WorkflowSettlement }) {
  try {
    const { declaration, key, fence } = input;
    const owner = workflowOwnerProcessSchema.parse(fence.ownerProcess), handle = handleSchema.parse(fence.handle);
    const host = hostname(), bootIdentity = owner.bootIdentity;
    if (owner.hostname !== host || handle.hostname !== host || handle.bootIdentity !== bootIdentity || !isCurrentProcessBootIdentity(bootIdentity)
      || handle.pid !== handle.pgid || handle.pid === owner.pid || handle.sessionId !== declaration.sessionId
      || handle.sessionId !== fence.sessionId || handle.turnId !== fence.turnId || handle.segmentId !== fence.segmentId) return undefined;
    const ownerPresence = absence(owner.pid);
    if (ownerPresence === "unknown") return undefined;
    if (ownerPresence === "present") {
      // Older captures did not specify a timezone. A caller TZ change must not
      // turn that ambiguous timestamp into a false proof of original-owner death.
      if (owner.startIdentity !== "ps_utc_v1") return undefined;
      // Exact start mismatch establishes only the original owner's death. The
      // unrelated current process is never signalled or treated as our worker.
      const started = nativeStart(owner.pid);
      if (started === undefined || started === owner.pid_started_at) return undefined;
    }
    if (absence(handle.pid) !== "absent" || absence(-handle.pgid) !== "absent") return undefined;
    return { version: 1 as const, bindingKey: declaration.bindingKey, key,
      sessionId: fence.sessionId, turnId: fence.turnId, segmentId: fence.segmentId, owner: fence.owner,
      handleHash: boundFingerprint(fence.handle), ownerProcessHash: boundFingerprint(owner),
      scopeHash: boundFingerprint(declaration.scope), selectionHash: boundFingerprint(declaration.selection),
      ownerDead: true as const, groupAbsent: true as const, hostname: host, bootIdentity, observedAt: Date.now(),
    };
  } catch { return undefined; }
}


/** Result-independent physical proof; never reads a spool or changes logical state. */
export function observeWorkflowPhysicalRecovery(input: {
  declaration: WorkflowDestinationBinding; key: string; fence: WorkflowSettlement;
  originalIntentHash: string; revision: number;
}): WorkflowPhysicalProof | undefined {
  try {
    const observed = observeWorkflowCessation(input);
    return observed && workflowPhysicalProofSchema.parse({ ...observed, originalIntentHash: input.originalIntentHash, revision: input.revision });
  } catch { return undefined; }
}

/** Outcome import requires the same native proof plus the exact retained digest. */
export function observeWorkflowOutcomeRecovery(input: {
  declaration: WorkflowDestinationBinding; key: string; fence: WorkflowSettlement; outcomeHash: string;
}): WorkflowRecoveryProof | undefined {
  try {
    const observed = observeWorkflowCessation(input);
    return observed && workflowRecoveryProofSchema.parse({ ...observed, outcomeHash: input.outcomeHash });
  } catch { return undefined; }
}
