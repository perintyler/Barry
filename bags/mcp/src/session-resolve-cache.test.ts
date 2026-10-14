import { describe, it, expect } from "vitest";
import {
  isCacheEntryUsable, traitKeyOf, SESSION_RESOLVE_TTL_MS, SESSION_RESOLVE_PENDING_DEADLINE_MS,
} from "./session-resolve-cache.js";

/**
 * The bug this guards.
 *
 * `barry start --traits notion` produced a session with ZERO notion tools. The
 * CLI asks the MCP server for the session's namespaces (`/session-namespaces`)
 * while building the agent's MCP config — which happens BEFORE it PATCHes the
 * chosen traits onto the session row. That early call resolved a trait-less
 * session and cached the result for 10s, so the agent's own initialize, landing
 * ~1.7s later, was served the stale resolution.
 *
 * It failed silently and looked exactly like success: the CLI printed
 * "Traits: notion", the DB stored `["notion"]`, and the session simply had no
 * notion tools. Only a trait outside DEFAULT_TRAITS exposes it — `artifacts`
 * and `coding` are already granted by default, which is why it hid for so long.
 *
 * Time-based expiry alone cannot fix this: the stale entry is FRESH by the
 * clock. The entry has to remember which traits it was computed from.
 */
describe("traitKeyOf", () => {
  it("ignores order, so a reordered array is not a false miss", () => {
    expect(traitKeyOf(["b", "a"])).toBe(traitKeyOf(["a", "b"]));
  });

  it("distinguishes a real change", () => {
    expect(traitKeyOf(["notion"])).not.toBe(traitKeyOf([]));
  });

  it("treats null and empty as the same absent state", () => {
    expect(traitKeyOf(null)).toBe(traitKeyOf([]));
  });

  // Names are joined, so a separator inside a name must not let two different
  // trait sets collide into one key.
  it("does not collide across the separator", () => {
    expect(traitKeyOf(["a,b"])).not.toBe(traitKeyOf(["a", "b"]));
  });
});

describe("isCacheEntryUsable", () => {
  const key = traitKeyOf(["notion"]);

  it("uses a fresh SETTLED entry whose traits still match", () => {
    expect(isCacheEntryUsable({ at: 1000, settledAt: 1000, traitKey: key }, 1500, key)).toBe(true);
  });

  // The actual bug: fresh by the clock, but computed before the traits landed.
  it("rejects a fresh entry whose traits have since changed", () => {
    const stale = { at: 1000, settledAt: 1000, traitKey: traitKeyOf([]) };
    expect(isCacheEntryUsable(stale, 1500, key)).toBe(false);
  });

  it("rejects a SETTLED entry past the short TTL, measured from settledAt", () => {
    const old = { at: 1000, settledAt: 1000, traitKey: key };
    expect(isCacheEntryUsable(old, 1000 + SESSION_RESOLVE_TTL_MS + 1, key)).toBe(false);
  });

  it("rejects a missing entry", () => {
    expect(isCacheEntryUsable(undefined, 1500, key)).toBe(false);
  });

  // The burst this cache exists for: many transports, same instant, same
  // traits. Collapsing them is the whole point and must keep working.
  it("still collapses a simultaneous burst", () => {
    const entry = { at: 1000, settledAt: 1000, traitKey: key };
    for (const t of [1000, 1001, 1050, 1999]) {
      expect(isCacheEntryUsable(entry, t, key)).toBe(true);
    }
  });

  /** Pending resolutions use a pending deadline distinct from the settled cache TTL.
   * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
   */
  describe("pending entries (settledAt: null)", () => {
    it("stays usable well past the short settled TTL, as long as it's still pending", () => {
      const pending = { at: 1000, settledAt: null, traitKey: key };
      // Fails against the old at-only check: SESSION_RESOLVE_TTL_MS is 10s,
      // so `now` here is ~25s after creation — the old code would reject this.
      const now = 1000 + SESSION_RESOLVE_TTL_MS * 2.5;
      expect(isCacheEntryUsable(pending, now, key)).toBe(true);
    });

    it("still rejects a pending entry past the (generous) absolute deadline", () => {
      const pending = { at: 1000, settledAt: null, traitKey: key };
      const now = 1000 + SESSION_RESOLVE_PENDING_DEADLINE_MS + 1;
      expect(isCacheEntryUsable(pending, now, key)).toBe(false);
    });

    it("still enforces the trait-key check while pending", () => {
      const pending = { at: 1000, settledAt: null, traitKey: traitKeyOf([]) };
      expect(isCacheEntryUsable(pending, 1500, key)).toBe(false);
    });
  });
});
