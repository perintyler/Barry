import { AsyncLocalStorage } from "node:async_hooks";
import { boundFingerprint, approvedBoundsSchema, type ApprovedBounds } from "../bounds/workflow-bounds.js";
import type { WorkAdmission } from "./work-contracts.js";
import { workGrantSchema } from "./work-contracts.js";
import { dispatchWorkerRequest, workWorkerSchema } from "./protocol.js";
import { createRunBoundRefresh, type RunBoundSources } from "./run-authorization.js";
import type { WorkflowOwner } from "./workflow-owner.js";
import type { z } from "zod";

type Grant = z.infer<typeof workGrantSchema>;
const policyKey = (work: WorkAdmission, worker: string, activity: string) => boundFingerprint([work.work_id, work.grant_revision, work.plan_digest, worker, activity]);

/** Fresh full-policy evaluation from the retained selections and delegation basis.
 * Service principals require an explicit installation policy, never identity defaults. */
export function createWorkScopeRefresh(sources: RunBoundSources & {
  serviceScope?: (work: WorkAdmission, grant: Grant) => Promise<ApprovedBounds | null>;
}) {
  const refresh = createRunBoundRefresh(sources);
  return async (work: WorkAdmission, grant: Grant): Promise<ApprovedBounds | null> => {
    if (grant.authorizer !== work.namespace.principal_id || boundFingerprint(grant.namespace) !== boundFingerprint(work.namespace)) return null;
    if (work.namespace.principal_kind === "service") return sources.serviceScope ? sources.serviceScope(work, grant) : null;
    if (work.namespace.principal_kind === "operator" && !sources.operator(grant.authorizer)) return null;
    if (work.namespace.principal_kind === "identity" && (sources.operator(grant.authorizer) || grant.original_caller_ceiling.identity !== grant.authorizer)) return null;
    const effective = grant.effective_scope, original = grant.original_caller_ceiling;
    return refresh({ identity: effective.identity, bags: effective.bags ?? effective.traits, bounds: effective.bounds, traits: effective.traits, harness: effective.harness, profile: work.plan.execution_profile },
      grant.authorizer, work.namespace.principal_kind === "identity" ? { identity: grant.authorizer, bags: original.bags ?? original.traits, bounds: original.bounds, traits: original.traits, harness: original.harness } : undefined);
  };
}

/** Async policy reads happen before owner transactions. Evidence exists only in
 * the matching authenticated RPC context, so direct calls and overlapping workers
 * cannot borrow a prior request's authorization. */
export class WorkPolicyDispatcher {
  private readonly scopes = new AsyncLocalStorage<Map<string, ApprovedBounds | null>>();
  constructor(private readonly resolve: (work: WorkAdmission, grant: Grant, worker: string, activity: string) => Promise<ApprovedBounds | null>) {}
  current = (work: WorkAdmission, worker: string, activity: string): ApprovedBounds | null =>
    this.scopes.getStore()?.get(policyKey(work, worker, activity)) ?? null;
  async dispatch(owner: WorkflowOwner, worker: string, input: unknown): Promise<unknown> {
    if (!input || typeof input !== "object" || !("version" in input) || input.version !== 3) return dispatchWorkerRequest(owner, worker, input);
    const request = workWorkerSchema.parse(input);
    if (request.operation === "hello") return dispatchWorkerRequest(owner, worker, request);
    owner.assertSession(worker, request.session, request.epoch);
    if (!["claim", "begin", "effect", "heartbeat", "delegation"].includes(request.operation)) return dispatchWorkerRequest(owner, worker, request);
    const token = "token" in request ? request.token : undefined;
    const entries = owner.workPolicyInputs(worker, token), scopes = new Map<string, ApprovedBounds | null>();
    await Promise.all(entries.map(async ({ work, grant, activity }) => {
      let current: ApprovedBounds | null = null;
      try { const evaluated = await this.resolve(work, grant, worker, activity); if (evaluated) current = approvedBoundsSchema.parse(evaluated); }
      catch { /* Unavailable current policy cannot grant new effects or lease renewal. */ }
      scopes.set(policyKey(work, worker, activity), current);
    }));
    return this.scopes.run(scopes, () => {
      try { return dispatchWorkerRequest(owner, worker, request); }
      finally { scopes.clear(); }
    });
  }
}
