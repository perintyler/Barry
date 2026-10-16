import { ReviewRulesSchema, type ReviewRules } from "@barry-rocks/sdk/sessions";

export type { ReviewRules };
export const APPROVAL_TIMEOUT_MS = 60_000;

/** Deadlines are persisted with the turn, so a restart cannot extend them. */
export function resolveReviewRules(value: unknown, now = Date.now()): ReviewRules {
  const rules = ReviewRulesSchema.parse(value ?? { mode: "review_required" });
  if (rules.mode === "automatic" || rules.expiresAt) return rules;
  return { ...rules, expiresAt: new Date(now + APPROVAL_TIMEOUT_MS).toISOString() };
}

export const sessionReviewRules = resolveReviewRules;
