import { describe, expect, it } from "vitest";
import { sessionReviewPolicy } from "./review-policy.js";

describe("session review policy", () => {
  it("assigns a persisted absolute deadline to interactive turns", () => {
    expect(sessionReviewPolicy(undefined, Date.parse("2026-10-09T12:00:00Z"))).toEqual({ mode: "review_required", expiresAt: "2026-10-09T12:01:00.000Z" });
  });
  it("preserves explicit deadlines and automatic automation policy", () => {
    expect(sessionReviewPolicy({ mode: "review_required", expiresAt: "2026-10-09T12:00:00Z" })).toEqual({ mode: "review_required", expiresAt: "2026-10-09T12:00:00Z" });
    expect(sessionReviewPolicy({ mode: "automatic" })).toEqual({ mode: "automatic" });
  });
  it("refuses malformed policies instead of dropping their restrictions", () => {
    expect(() => sessionReviewPolicy({ mode: "review_required", expiresAt: "never" })).toThrow();
    expect(() => sessionReviewPolicy({ mode: "automatic", unknown: true })).toThrow();
  });
});
