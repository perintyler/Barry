import { describe, expect, it } from "vitest";
import { resolveReviewRules } from "./review-rules.js";

describe("session review rules", () => {
  it("assigns a persisted absolute deadline to interactive turns", () => {
    expect(resolveReviewRules(undefined, Date.parse("2026-10-09T12:00:00Z"))).toEqual({ mode: "review_required", expiresAt: "2026-10-09T12:01:00.000Z" });
  });
  it("preserves explicit deadlines and automatic automation rules", () => {
    expect(resolveReviewRules({ mode: "review_required", expiresAt: "2026-10-09T12:00:00Z" })).toEqual({ mode: "review_required", expiresAt: "2026-10-09T12:00:00Z" });
    expect(resolveReviewRules({ mode: "automatic" })).toEqual({ mode: "automatic" });
  });
  it("refuses malformed rules instead of dropping their restrictions", () => {
    expect(() => resolveReviewRules({ mode: "review_required", expiresAt: "never" })).toThrow();
    expect(() => resolveReviewRules({ mode: "automatic", unknown: true })).toThrow();
  });
});
