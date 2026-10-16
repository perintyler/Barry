import {
  approvedBoundsSchema,
  boundFingerprint,
  type ApprovedBounds,
} from "../bounds/workflow-bounds.js";
import { mergeBounds } from "../bounds/merge-bounds.js";
import { workGrantSchema, type WorkNamespace, type WorkSubmission } from "./work-contracts.js";
import { WorkflowError } from "./errors.js";
import type { z } from "zod";

/** Supplied only by the trusted transport/policy verifier; never parsed from the submission body. */
export interface WorkAuthority {
  namespace: WorkNamespace;
  caller_ceiling: ApprovedBounds;
  origin: WorkSubmission["origin"];
  run_identity: string | null;
  current_caller_ceiling?: ApprovedBounds;
  delegation?: {
    issuer: string;
    key_id: string;
    nonce: string;
    request_hash: string;
    assertion_hash: string;
    record_digest: string;
    expires_at: number;
    evidence: unknown;
  };
}
export type WorkGrant = z.infer<typeof workGrantSchema>;
function semanticBound(value: unknown): unknown {
  if (Array.isArray(value)) return [...new Set(value)].sort();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, semanticBound(item)]),
    );
  return value;
}
function verifyScope(scope: ApprovedBounds): void {
  const { fingerprint, ...evidence } = approvedBoundsSchema.parse(scope);
  if (boundFingerprint(evidence) !== fingerprint)
    throw new WorkflowError(
      "InvalidGrant",
      "Scope fingerprint does not match immutable evidence.",
      403,
    );
}
/** Enforce the complete ceiling, including raw-process/native/files/network/node restrictions. */
export function validateWorkGrant(grant: WorkGrant, authority: WorkAuthority): WorkGrant {
  grant = workGrantSchema.parse(grant);
  verifyScope(grant.original_caller_ceiling);
  verifyScope(grant.effective_scope);
  verifyScope(authority.caller_ceiling);
  if (
    boundFingerprint(grant.namespace) !== boundFingerprint(authority.namespace) ||
    boundFingerprint(grant.original_caller_ceiling) !==
      boundFingerprint(authority.caller_ceiling) ||
    grant.authorizer !== authority.namespace.principal_id ||
    grant.created_by !== authority.namespace.principal_id ||
    grant.revision !== 1 ||
    (grant.effective_scope.identity ?? null) !== authority.run_identity
  )
    throw new WorkflowError(
      "InvalidGrant",
      "Grant is not bound to the authenticated caller and identity.",
      403,
    );
  assertScopeWithinCeiling(grant.original_caller_ceiling, grant.effective_scope);
  if (authority.current_caller_ceiling)
    assertScopeWithinCeiling(authority.current_caller_ceiling, grant.effective_scope);
  return grant;
}

export function assertScopeWithinCeiling(caller: ApprovedBounds, effective: ApprovedBounds): void {
  verifyScope(caller);
  verifyScope(effective);

  if (caller.harness && caller.harness !== effective.harness)
    throw new WorkflowError(
      "HarnessContractRequired",
      "Changing a delegated harness requires a verified native-tool contract.",
      403,
    );
  const combined = mergeBounds(caller.bound, effective.bound);
  if (
    boundFingerprint(semanticBound(combined)) !==
    boundFingerprint(semanticBound(mergeBounds(null, effective.bound)))
  )
    throw new WorkflowError(
      "AuthorityWidened",
      "Definition scope widens the caller's persisted bounds.",
      403,
    );
  if (effective.traits.some((trait) => !caller.traits.includes(trait)))
    throw new WorkflowError("AuthorityWidened", "Definition scope widens selected traits.", 403);
  for (const [tool, access] of Object.entries(effective.tools)) {
    if (
      caller.tools[tool] !== access ||
      !caller.contracts?.[tool] ||
      caller.contracts[tool] !== effective.contracts?.[tool]
    )
      throw new WorkflowError(
        "AuthorityWidened",
        "Definition scope widens or changes a named tool contract.",
        403,
      );
  }
}
