import { describe, it, expect } from "vitest";
import {
  isCacheEntryUsable,
  selectionKeyOf,
  SESSION_RESOLVE_TTL_MS,
  SESSION_RESOLVE_PENDING_DEADLINE_MS,
} from "./session-resolve-cache.js";

/**
 * The bug this guards.
 *
 * `barry start --bag notion` produced a session with ZERO notion tools when the
 * CLI asked the MCP server for the session's namespaces (`/session-namespaces`)
 * while building the agent's MCP config — BEFORE it PATCHed the chosen bags and
 * bounds onto the session row. That early call resolved an unselected session
 * and cached the result for 10s, so the agent's own initialize, landing ~1.7s
 * later, was served the stale resolution.
 *
 * Time-based expiry alone cannot fix this: the stale entry is FRESH by the
 * clock. The entry has to remember which bags, bounds, and pinned bound it was
 * computed from.
 */
describe("selectionKeyOf", () => {
  it("ignores order across bags and bounds, so a reordered array is not a false miss", () => {
    expect(selectionKeyOf({ bags: ["b", "a"], bounds: ["y", "x"] })).toBe(
      selectionKeyOf({ bags: ["a", "b"], bounds: ["x", "y"] }),
    );
  });

  it("distinguishes a real change in bags, bounds, or pinned bound", () => {
    expect(selectionKeyOf({ bags: ["notion"] })).not.toBe(selectionKeyOf({ bags: [] }));
    expect(selectionKeyOf({ bounds: ["readonly"] })).not.toBe(selectionKeyOf({ bounds: [] }));
    expect(selectionKeyOf({ bound: { tools: { deny: ["*:write"] } } })).not.toBe(
      selectionKeyOf({ bound: null }),
    );
    expect(selectionKeyOf({ bags: ["a"], bounds: [] })).not.toBe(
      selectionKeyOf({ bags: [], bounds: ["a"] }),
    );
  });

  it("canonicalizes pinned bound key order", () => {
    expect(
      selectionKeyOf({
        bound: { tools: { allow: ["a"], deny: ["b"] }, network: { deny: ["*"] } },
      }),
    ).toBe(
      selectionKeyOf({
        bound: { network: { deny: ["*"] }, tools: { deny: ["b"], allow: ["a"] } },
      }),
    );
  });

  it("treats null, empty object, and empty arrays as the same absent state", () => {
    expect(selectionKeyOf(null)).toBe(selectionKeyOf({}));
    expect(selectionKeyOf({})).toBe(selectionKeyOf({ bags: [], bounds: [], bound: null }));
  });

  it("does not collide across the separator or escape character", () => {
    expect(selectionKeyOf({ bags: ["a,b"] })).not.toBe(selectionKeyOf({ bags: ["a", "b"] }));
    expect(selectionKeyOf({ bags: ["a|b"] })).not.toBe(
      selectionKeyOf({ bags: ["a"], bounds: ["b"] }),
    );
  });
});

describe("isCacheEntryUsable", () => {
  const key = selectionKeyOf({ bags: ["notion"], bounds: ["readonly"] });

  it("uses a fresh SETTLED entry whose selection still matches", () => {
    expect(isCacheEntryUsable({ at: 1000, settledAt: 1000, selectionKey: key }, 1500, key)).toBe(
      true,
    );
  });

  it("rejects a fresh entry whose bags, bounds, or pinned bound have since changed", () => {
    const stale = { at: 1000, settledAt: 1000, selectionKey: selectionKeyOf({}) };
    expect(isCacheEntryUsable(stale, 1500, key)).toBe(false);
  });

  it("rejects a SETTLED entry past the short TTL, measured from settledAt", () => {
    const old = { at: 1000, settledAt: 1000, selectionKey: key };
    expect(isCacheEntryUsable(old, 1000 + SESSION_RESOLVE_TTL_MS + 1, key)).toBe(false);
  });

  it("rejects a missing entry", () => {
    expect(isCacheEntryUsable(undefined, 1500, key)).toBe(false);
  });

  it("still collapses a simultaneous burst", () => {
    const entry = { at: 1000, settledAt: 1000, selectionKey: key };
    for (const t of [1000, 1001, 1050, 1999]) {
      expect(isCacheEntryUsable(entry, t, key)).toBe(true);
    }
  });

  /** Pending resolutions use a pending deadline distinct from the settled cache TTL.
   * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
   */
  describe("pending entries (settledAt: null)", () => {
    it("stays usable well past the short settled TTL, as long as it's still pending", () => {
      const pending = { at: 1000, settledAt: null, selectionKey: key };
      const now = 1000 + SESSION_RESOLVE_TTL_MS * 2.5;
      expect(isCacheEntryUsable(pending, now, key)).toBe(true);
    });

    it("still rejects a pending entry past the (generous) absolute deadline", () => {
      const pending = { at: 1000, settledAt: null, selectionKey: key };
      const now = 1000 + SESSION_RESOLVE_PENDING_DEADLINE_MS + 1;
      expect(isCacheEntryUsable(pending, now, key)).toBe(false);
    });

    it("still enforces the selection-key check while pending", () => {
      const pending = { at: 1000, settledAt: null, selectionKey: selectionKeyOf({}) };
      expect(isCacheEntryUsable(pending, 1500, key)).toBe(false);
    });
  });
});
