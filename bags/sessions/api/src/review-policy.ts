import { ReviewPolicySchema, type ReviewPolicy } from "@barry-rocks/sdk/sessions";

export const APPROVAL_TIMEOUT_MS = 60_000;

/** Deadlines are persisted with the turn, so a restart cannot extend them. */
export function sessionReviewPolicy(value: unknown, now = Date.now()): ReviewPolicy {
  const policy = ReviewPolicySchema.parse(value ?? { mode: "review_required" });
  if (policy.mode === "automatic" || policy.expiresAt) return policy;
  return { ...policy, expiresAt: new Date(now + APPROVAL_TIMEOUT_MS).toISOString() };
}
