import { z } from "zod";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { assertScopeWithinCeiling } from "./work-authority.js";
import {
  executorFeaturesSchema, executorObservationSchema, executorStartSchema, workGrantSchema, workNamespaceSchema, workOriginSchema,
  workPlanHash, workPlanSchema, workReceiptSchema,
} from "./work-contracts.js";
import { advertisementSchema, encodeEnvelope, type Json } from "./types.js";

/** Evidence returned by the authenticated owner for an active assigned attempt.
 * This is not a bearer credential or offline permission to launch. Consumers
 * must retain their authenticated owner connection and refresh effect authority
 * before credentials, model input or other effects. No principal is synthesized.
 */
export const workExecutionDelegationSchema = z.strictObject({
  version: z.literal(1),
  admission_request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  start: executorStartSchema.safeExtend({ launch_authorized: z.literal(true), activity_type: executorStartSchema.shape.activity_type.unwrap() }),
  namespace: workNamespaceSchema,
  origin: workOriginSchema,
  grant: workGrantSchema,
  plan: workPlanSchema,
}).superRefine((value, context) => {
  const { start, namespace, grant, plan } = value;
  const same = (left: unknown, right: unknown) => boundFingerprint(left ?? null) === boundFingerprint(right ?? null);
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  // Bound the complete decoded response before hashing any nested plan. A
  // structurally valid oversized plan must fail validation, not throw from its
  // digest helper before safeParse can report a refusal.
  try { encodeEnvelope(value); }
  catch { reject("delegation exceeds the common worker envelope limit");return; }
  if (!start.launch_authorized || !start.activity_type || !start.resources.host_reservation
    || start.resources.endpoint && !start.resources.endpoint.reservation)
    reject("delegation requires an activated attempt with held resource references");
  if (start.owner !== namespace.installation || !same(grant.namespace, namespace)
    || grant.authorizer !== namespace.principal_id || grant.created_by !== namespace.principal_id
    || (value.origin.caller_session_id ?? null) !== namespace.caller_session_id
    || (grant.effective_scope.identity ?? null) !== namespace.identity_id
    || start.output_identity !== undefined && start.output_identity !== namespace.identity_id)
    reject("delegation namespace or execution identity differs");
  if (start.grant_ref !== grant.grant_ref || start.grant_revision !== grant.revision
    || plan.grant_ref !== grant.grant_ref || plan.grant_revision !== grant.revision
    || plan.grant_digest !== boundFingerprint(grant) || start.plan_digest !== workPlanHash(plan))
    reject("delegation grant or plan differs from the accepted binding");
  if (start.request_hash !== boundFingerprint({ admission: value.admission_request_hash,
    activity: start.activity_id, type: start.activity_type, input: start.inputs }))
    reject("delegation input differs from the accepted activity request");
  if (!plan.source_closure.some(source => source.purpose === "source" && same(source, start.source))
    || start.executor_generation !== plan.executor_generation || !same(start.effect_policy, plan.effect_policy)
    || !same(start.validation, plan.validation) || !same(start.node_job, plan.node_job)
    || !same(start.process_program, plan.process_program) || !same(start.agent_program, plan.agent_program)
    || start.agent_program && (!same(start.agent_program.scope, grant.effective_scope) || start.agent_program.installation !== namespace.installation))
    reject("delegation executable declaration differs from the accepted plan");
  const resources = (resource: typeof start.resources) => ({ ...resource, host_reservation: null,
    endpoint: resource.endpoint ? { ...resource.endpoint, reservation: null } : null });
  if (!same(resources(start.resources), resources(plan.resources)))
    reject("delegation resource placement differs from the accepted plan");
  try { assertScopeWithinCeiling(grant.original_caller_ceiling, grant.effective_scope); }
  catch { reject("delegation scope differs from its original verified ceiling"); }
});

export type WorkExecutionDelegation = z.infer<typeof workExecutionDelegationSchema>;

export interface WorkOwnerConnection {
  advertise: (advertisement: z.input<typeof advertisementSchema>, features: z.infer<typeof executorFeaturesSchema>) => Promise<void>;
  claim: (requestId: string) => Promise<{
    work?: z.infer<typeof executorStartSchema> | undefined;
    owner: string;
    runId: string;
    activityId: string;
    idempotencyKey: string;
    type: string;
    input: Json;
    attempt: number;
    token: string;
    artifact?: string | undefined;
    grantRevision?: number | undefined;
    deadline: number;
    timeoutMs: number;
    heartbeatMs: number;
  } | null>;
  heartbeat: (token: string) => Promise<boolean>;
  begin: (token: string) => Promise<z.infer<typeof executorStartSchema>>;
  effect: (token: string) => Promise<boolean>;
  delegation: (token: string) => Promise<WorkExecutionDelegation>;
  inspect: (token: string) => Promise<{ observation: z.infer<typeof executorObservationSchema>; stop_requested: boolean }>;
  observe: (token: string, observation: z.infer<typeof executorObservationSchema>) => Promise<{ status: "accepted" | "duplicate" | "stale" }>;
  complete: (token: string, receipt: z.infer<typeof workReceiptSchema>) => Promise<{ status: "accepted" | "alreadyAccepted" | "stale" }>;
}
