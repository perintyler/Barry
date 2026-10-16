import { z } from "zod";
import type { WorkAdmission, WorkControl } from "./work-contracts.js";
import type { WorkReadScope } from "./work-read.js";
import { WorkflowError } from "./errors.js";
import type { WorkflowOwner } from "./workflow-owner.js";
const ref = z.string().min(1).max(200);
export const workReconciliationSchema = z.strictObject({
  request_id: z.uuid(),
  expected_revision: z.number().int().positive(),
  attempt_id: ref,
  receipt_digest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(2000),
  residual_risk: z.string().trim().min(1).max(2000),
});
export type WorkReconciliation = z.infer<typeof workReconciliationSchema>;
export interface WorkReconciliationAck {
  version: 2;
  work_id: string;
  request_id: string;
  receipt_digest: string;
  applied_revision: number;
  applied_at: number;
}
export const workStopSchema = z.strictObject({ request_id: z.uuid(), expected_revision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000).optional() });
export type WorkStop = z.infer<typeof workStopSchema>;
export interface WorkStopAck {
  version: 2;
  work_id: string;
  request_id: string;
  applied_revision: number;
  applied_at: number;
  stop_requested: true;
}
/** Actor/scope/permission come from the trusted authorizer, not the control body. */
export class WorkControlService<Credentials> {
  constructor(
    private readonly options: {
      authorize: (
        credentials: Credentials,
        workId: string,
        operation: "reconcile" | "stop",
      ) => Promise<{ actor: string; scope: WorkReadScope; controls: readonly WorkControl[] }>;
      owner: {
        scopedWork(scope: WorkReadScope, workId: string): WorkAdmission | null;
        workReconciliationEvidence: WorkflowOwner["workReconciliationEvidence"];
        stopWork(workId: string, request: WorkStop, actor: string): WorkStopAck;
        reconcileWorkReceipt(
          workId: string,
          request: WorkReconciliation,
          actor: string,
        ): WorkReconciliationAck;
      };
    },
  ) {}
  async evidence(workId: string, credentials: Credentials) {
    workId = ref.parse(workId);
    const authority = await this.options.authorize(credentials, workId, "reconcile");
    if (!authority.controls.includes("reconcile")) throw new WorkflowError("Forbidden", "Current caller cannot review reconciliation evidence.", 403);
    if (!this.options.owner.scopedWork(authority.scope, workId)) throw new WorkflowError("WorkNotFound", "Work is unavailable to this caller.", 404);
    return this.options.owner.workReconciliationEvidence(workId);
  }
  async stop(workId: string, input: WorkStop, credentials: Credentials): Promise<WorkStopAck> {
    workId = ref.parse(workId);
    const request = workStopSchema.parse(input), authority = await this.options.authorize(credentials, workId, "stop");
    if (!authority.controls.includes("stop")) throw new WorkflowError("Forbidden", "Current caller cannot stop work.", 403);
    if (!this.options.owner.scopedWork(authority.scope, workId)) throw new WorkflowError("WorkNotFound", "Work is unavailable to this caller.", 404);
    return this.options.owner.stopWork(workId, request, ref.parse(authority.actor));
  }
  async reconcile(
    workId: string,
    input: WorkReconciliation,
    credentials: Credentials,
  ): Promise<WorkReconciliationAck> {
    workId = ref.parse(workId);
    const request = workReconciliationSchema.parse(input);
    const authority = await this.options.authorize(credentials, workId, "reconcile");
    if (!authority.controls.includes("reconcile"))
      throw new WorkflowError("Forbidden", "Current caller cannot reconcile work.", 403);
    if (!this.options.owner.scopedWork(authority.scope, workId))
      throw new WorkflowError("WorkNotFound", "Work is unavailable to this caller.", 404);
    return this.options.owner.reconcileWorkReceipt(workId, request, ref.parse(authority.actor));
  }
}
