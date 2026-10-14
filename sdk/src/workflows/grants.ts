import { z } from "zod";
import { executionScopeSchema, scopeFingerprint, type ExecutionScope } from "../bounds/execution-scope.js";
import type { ExecutionContext } from "../bounds/execution-context.js";

const reference = z.string().min(1).max(200);
/**
 * The execution a run asks for. Sent and stored under the field `job`, a name
 * from before bags had jobs, kept so recorded runs and grants stay readable.
 */
export const runRequestSchema = z.strictObject({
  traits: z.array(reference).max(100), identity: reference.optional(), harness: reference.optional(),
  action: z.strictObject({ name: reference, version: reference }).optional(),
  profile: z.enum(["portable", "resource-contained"]).default("portable"),
});
export type RunRequest = z.input<typeof runRequestSchema>;
export const runGrantSchema = z.strictObject({
  revision: z.number().int().positive(), authorizer: reference, createdBy: reference,
  approvedAt: z.number().int().nonnegative(), reason: z.string().min(1).max(1000),
  scope: executionScopeSchema, job: runRequestSchema,
  delegation: z.strictObject({ identity: reference, traits: z.array(reference).max(100), harness: reference.optional() }).optional(),
});
export type RunGrant = z.infer<typeof runGrantSchema>;
export type RunAuthorization = (request: RunRequest, principal: string, delegator?: ExecutionContext) => Promise<ExecutionScope>;

export async function authorizeRun(request: RunRequest, principal: string, authorize: RunAuthorization, now = Date.now(), delegator?: ExecutionContext): Promise<RunGrant> {
  if (delegator && delegator.identity !== principal) throw new Error("delegation basis does not identify the authorizing principal");
  const parsed = runRequestSchema.parse(request);
  const scope = executionScopeSchema.parse(await authorize(parsed, principal, delegator));
  if (scope.identity !== parsed.identity || scope.harness !== parsed.harness) throw new Error("authorized identity/harness differs from the run request");
  // Expanded includes may differ from selected names, but every selected root must be represented.
  if (parsed.traits.some(name => !scope.traits.includes(name))) throw new Error("authorized scope omits selected run traits");
  return runGrantSchema.parse(JSON.parse(JSON.stringify({ revision: 1, authorizer: principal, createdBy: principal, approvedAt: now, reason: "Run admitted", scope, job: parsed,
    ...(delegator ? { delegation: { identity: delegator.identity, traits: delegator.traits, harness: delegator.harness } } : {}) })));
}

export function grantRequestHash(grant: RunGrant): string { return scopeFingerprint({ job: grant.job, authorizer: grant.authorizer, createdBy: grant.createdBy }); }
