import { z } from "zod";
import { approvedBoundsSchema, boundFingerprint, type ApprovedBounds } from "../bounds/workflow-bounds.js";
import type { ToolCallBounds } from "../bounds/resolve-bound.js";

const reference = z.string().min(1).max(200);
/**
 * The execution a run asks for. Sent and stored under the field `job`, a name
 * from before bags had jobs, kept so recorded runs and approvals stay readable.
 */
export const runRequestSchema = z.strictObject({
  bags: z.array(reference).max(100).optional(),
  bounds: z.array(reference).max(100).optional(),
  traits: z.array(reference).max(100).default([]),
  identity: reference.optional(),
  harness: reference.optional(),
  action: z.strictObject({ name: reference, version: reference }).optional(),
  profile: z.enum(["portable", "resource-contained"]).default("portable"),
});
export type RunRequest = z.input<typeof runRequestSchema>;
export type ParsedRunRequest = z.output<typeof runRequestSchema>;

export const runApprovalSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]).default(2),
    revision: z.number().int().positive(),
    authorizer: reference,
    createdBy: reference,
    approvedAt: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1000),
    scope: approvedBoundsSchema,
    job: runRequestSchema,
    delegation: z
      .strictObject({
        identity: reference,
        bags: z.array(reference).max(100).optional(),
        bounds: z.array(reference).max(100).optional(),
        traits: z.array(reference).max(100).default([]),
        harness: reference.optional(),
      })
      .optional(),
  })
  .refine(
    (a) => a.version === 2 || (!a.job.bags?.length && !a.job.bounds?.length),
    { message: "version 1 approvals cannot carry bag/bound requests" },
  );
export type RunApproval = z.infer<typeof runApprovalSchema>;
export type RunAuthorization = (
  request: ParsedRunRequest,
  principal: string,
  delegator?: ToolCallBounds,
) => Promise<ApprovedBounds>;

export async function authorizeRun(
  request: RunRequest,
  principal: string,
  authorize: RunAuthorization,
  now = Date.now(),
  delegator?: ToolCallBounds,
): Promise<RunApproval> {
  if (delegator && delegator.identity !== principal) {
    throw new Error("delegation basis does not identify the authorizing principal");
  }
  const parsed = runRequestSchema.parse(request);
  const scope = approvedBoundsSchema.parse(await authorize(parsed, principal, delegator));
  if (scope.identity !== parsed.identity || scope.harness !== parsed.harness) {
    throw new Error("authorized identity/harness differs from the run request");
  }
  if (parsed.bags?.some((name) => !(scope.bags ?? []).includes(name))) {
    throw new Error("authorized scope omits selected run bags");
  }
  // Expanded includes may differ from selected names, but every selected root must be represented.
  if (parsed.traits.some((name) => !scope.traits.includes(name))) {
    throw new Error("authorized scope omits selected run traits");
  }
  return runApprovalSchema.parse(
    JSON.parse(
      JSON.stringify({
        version: 2,
        revision: 1,
        authorizer: principal,
        createdBy: principal,
        approvedAt: now,
        reason: "Run admitted",
        scope,
        job: parsed,
        ...(delegator
          ? {
              delegation: {
                identity: delegator.identity,
                ...(delegator.bags !== undefined ? { bags: delegator.bags } : {}),
                ...(delegator.bounds !== undefined ? { bounds: delegator.bounds } : {}),
                harness: delegator.harness,
              },
            }
          : {}),
      }),
    ),
  );
}

export function approvalRequestHash(grant: RunApproval): string {
  return boundFingerprint({ job: grant.job, authorizer: grant.authorizer, createdBy: grant.createdBy });
}
