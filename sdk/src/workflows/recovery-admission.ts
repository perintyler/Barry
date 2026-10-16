import { z } from "zod";
import type { WorkflowStore } from "./workflow-store.js";
import { WorkflowError } from "./errors.js";
import { encodeEnvelope } from "./types.js";
const ref = z.string().min(1).max(200);
export const recoveryAdmissionSchema = z.strictObject({ version: z.literal(1), epoch: z.uuid(), snapshot_at: z.string().nullable(), restored_at: z.string(), active: z.boolean() });
export const recoveryActivationSchema = z.strictObject({ request_id: z.uuid(), expected_epoch: z.uuid(), reason: z.string().trim().min(1).max(2000), residual_risk: z.string().trim().min(1).max(2000), effect_paths_fenced: z.literal(true), post_snapshot_work_reviewed: z.literal(true) });
export type RecoveryActivation = z.infer<typeof recoveryActivationSchema>;
export interface RecoveryActivationAck { version: 1; epoch: string; request_id: string; actor: string; at: number; admission_active: true }
const ackSchema = z.strictObject({ version: z.literal(1), epoch: z.uuid(), request_id: z.uuid(), actor: ref, at: z.number().int().nonnegative(), admission_active: z.literal(true) });
function auditForEpoch(store: Pick<WorkflowStore, "one">, epoch: string) {
  const row = store.one<{request: string; response: string}>("SELECT request,response FROM workflow_recovery_activations WHERE epoch=?", epoch);
  if (!row) return null;
  const decision = recoveryActivationSchema.extend({ actor: ref }).parse(JSON.parse(row.request)), acknowledgement = ackSchema.parse(JSON.parse(row.response));
  if (decision.expected_epoch !== epoch || acknowledgement.epoch !== epoch || acknowledgement.request_id !== decision.request_id || acknowledgement.actor !== decision.actor) throw new WorkflowError("RecoveryStateInvalid", "Recovery activation audit does not match this owner generation.", 409);
  return { decision, acknowledgement };
}
export function readRecoveryActivation(store: Pick<WorkflowStore, "one">) {
  const state = readRecoveryAdmission(store); return state ? auditForEpoch(store, state.epoch) : null;
}
export function readRecoveryAdmission(store: Pick<WorkflowStore, "one">) {
  const row = store.one<{value: string}>("SELECT value FROM workflow_meta WHERE key='recovery-admission'");
  if (!row) return null;
  const state = recoveryAdmissionSchema.parse(JSON.parse(row.value));
  if (store.one<{value: string}>("SELECT value FROM workflow_meta WHERE key='epoch'")?.value !== state.epoch) throw new WorkflowError("RecoveryStateInvalid", "Recovery admission evidence does not match the owner generation.", 409);
  if (state.active !== Boolean(auditForEpoch(store, state.epoch))) throw new WorkflowError("RecoveryStateInvalid", "Recovery admission state requires its matching immutable activation audit.", 409);
  return state;
}
export function assertRecoveryAdmission(store: Pick<WorkflowStore, "one">, key: string, epoch?: string) {
  const state = readRecoveryAdmission(store);
  if (!state) { if (epoch !== undefined) throw new WorkflowError("RecoveryEpochMismatch", "This owner has no active recovery generation.", 409); return; }
  if (!state.active) throw new WorkflowError("RecoveryAdmissionPaused", "New work is paused after restore. Review the recovery gap and record an operator activation decision.", 409);
  if (epoch !== state.epoch || !key.startsWith(`${state.epoch}:`)) throw new WorkflowError("RecoveryEpochRequired", `New invocations require recovery epoch ${state.epoch} and a new key prefixed with that epoch. Investigate unconfirmed pre-restore work; do not replace its key.`, 409);
}
/** The authenticated adapter supplies actor; input cannot choose it. Does not resume any run. */
export function activateRecoveryAdmission(store: WorkflowStore, input: RecoveryActivation, actor: string, now: number): RecoveryActivationAck {
  const request = recoveryActivationSchema.parse(input); actor = ref.parse(actor);
  const binding = encodeEnvelope({ actor, ...request });
  return store.transaction(() => {
    const state = readRecoveryAdmission(store);
    if (!state || state.epoch !== request.expected_epoch) throw new WorkflowError("RecoveryEpochMismatch", "Inspect the current recovery generation before activating admission.", 409);
    const previous = store.one<{request: string; response: string}>("SELECT request,response FROM workflow_recovery_activations WHERE epoch=?", state.epoch);
    if (previous) {
      if (previous.request !== binding) throw new WorkflowError("RecoveryActivationConflict", "This recovery generation already has another immutable activation decision.", 409);
      return JSON.parse(previous.response) as RecoveryActivationAck;
    }
    if (store.one("SELECT 1 FROM workflow_recovery_activations WHERE request_id=?", request.request_id)) throw new WorkflowError("RecoveryActivationConflict", "Activation request ID belongs to another recovery generation.", 409);
    if (state.active) throw new WorkflowError("RecoveryActivationConflict", "Recovery activation evidence is unavailable; admission cannot be widened.", 409);
    if (store.one<{n: number}>("SELECT count(*) n FROM workflow_recovery_activations")!.n >= 1000) throw new WorkflowError("RecoveryAuditQuota", "Recovery audit requires explicit archival.", 429);
    store.admit(8192);
    const ack: RecoveryActivationAck = { version: 1, epoch: state.epoch, request_id: request.request_id, actor, at: now, admission_active: true };
    store.run("INSERT INTO workflow_recovery_activations VALUES(?,?,?,?)", state.epoch, request.request_id, binding, encodeEnvelope(ack));
    store.run("UPDATE workflow_meta SET value=? WHERE key='recovery-admission'", encodeEnvelope({ ...state, active: true }));
    return ack;
  });
}
