import { describe, it, expect } from "vitest";
import { filterBagsNeedingAuthForSession } from "../../vault/oauth.js";

/**
 * The bug this guards: the CLI prompted to authorize every OAuth bag installed
 * on the identity, including ones the session's active bags never select. Tool
 * access is gated by the session's bags, not by installation, so the prompt
 * must follow the session's selection.
 */
describe("filterBagsNeedingAuthForSession", () => {
  const unauthorized = [
    { name: "sentry", url: "https://sentry.example/mcp" },
    { name: "notion", url: "https://notion.example/mcp" },
    { name: "linear", url: "https://linear.example/mcp" },
  ];

  it("drops bags the session's namespaces do not grant", () => {
    const result = filterBagsNeedingAuthForSession(unauthorized, ["sentry"]);
    expect(result.map((b) => b.name)).toEqual(["sentry"]);
  });

  it("returns nothing when the session grants no matching namespace", () => {
    const result = filterBagsNeedingAuthForSession(unauthorized, ["git", "changes"]);
    expect(result).toEqual([]);
  });

  // An empty grant is a real answer, not a missing one: a session that resolved
  // to zero namespaces should be prompted for zero bags.
  it("treats an empty array as a resolved grant of nothing", () => {
    expect(filterBagsNeedingAuthForSession(unauthorized, [])).toEqual([]);
  });

  // ...but an UNRESOLVED selection must not be mistaken for an empty one, or a
  // namespace-resolution outage would silently stop prompting for every bag.
  it("falls back to every unauthorized bag when the grant is unknown", () => {
    const result = filterBagsNeedingAuthForSession(unauthorized, undefined);
    expect(result.map((b) => b.name)).toEqual(["sentry", "notion", "linear"]);
  });

  it("keeps every granted bag when several match", () => {
    const result = filterBagsNeedingAuthForSession(unauthorized, ["sentry", "linear"]);
    expect(result.map((b) => b.name)).toEqual(["sentry", "linear"]);
  });
});
