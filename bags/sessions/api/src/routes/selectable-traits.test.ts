import { describe, expect, it } from "vitest";
import { mergeActiveIntoSelectable, parseIdentityIdParam } from "./session-lifecycle.js";

/**
 * Guards the rule that makes bag-scoped trait menus safe: narrowing what we
 * *offer* must never hide what a session already *has*.
 *
 * The traits table is append-only, so it accumulates rows from every bag ever
 * synced. `/tools/resolved` and `/tools/preview` therefore offer only traits a
 * reachable bag still backs — but a running session can hold a trait whose bag
 * was uninstalled after it started. If that trait vanished from `available`,
 * the UI would render it as active-but-absent: checked, invisible, and
 * impossible to switch off.
 */

type Trait = Parameters<typeof mergeActiveIntoSelectable>[0][number];

const trait = (name: string, bag: string | null = null): Trait => ({
  name,
  description: `${name} description`,
  tools: [],
  namespaces: [name],
  access: "read",
  skills: [],
  instructions: [],
  bound: {},
  boundNames: [],
  bag,
});

describe("mergeActiveIntoSelectable", () => {
  it("returns the selectable list untouched when nothing is active", () => {
    const selectable = [trait("git"), trait("slack")];
    const result = mergeActiveIntoSelectable(selectable, [...selectable, trait("gone")], []);
    expect(result.map((t) => t.name)).toEqual(["git", "slack"]);
  });

  it("keeps an active trait that is no longer selectable", () => {
    // `stale` belongs to a bag this barry no longer holds, so it is absent
    // from the selectable menu — but the session is actively using it.
    const selectable = [trait("git"), trait("slack")];
    const all = [...selectable, trait("stale", "removed-bag")];

    const result = mergeActiveIntoSelectable(selectable, all, ["stale"]);

    expect(result.map((t) => t.name)).toEqual(["git", "slack", "stale"]);
  });

  it("does not duplicate an active trait that is already selectable", () => {
    const selectable = [trait("git"), trait("slack")];
    const result = mergeActiveIntoSelectable(selectable, selectable, ["git"]);
    expect(result.map((t) => t.name)).toEqual(["git", "slack"]);
  });

  it("ignores an active name with no row anywhere", () => {
    // A trait deleted outright must not surface as a phantom entry.
    const selectable = [trait("git")];
    const result = mergeActiveIntoSelectable(selectable, selectable, ["never-existed"]);
    expect(result.map((t) => t.name)).toEqual(["git"]);
  });

  it("preserves selectable order and appends stragglers", () => {
    const selectable = [trait("a"), trait("b"), trait("c")];
    const all = [...selectable, trait("y", "gone"), trait("z", "gone")];

    const result = mergeActiveIntoSelectable(selectable, all, ["z", "y"]);

    expect(result.map((t) => t.name)).toEqual(["a", "b", "c", "z", "y"]);
  });

  it("does not mutate the selectable array it was given", () => {
    const selectable = [trait("git")];
    const all = [...selectable, trait("stale", "gone")];

    mergeActiveIntoSelectable(selectable, all, ["stale"]);

    expect(selectable.map((t) => t.name)).toEqual(["git"]);
  });
});

describe("parseIdentityIdParam", () => {
  it("treats an absent param as no barry", () => {
    expect(parseIdentityIdParam(undefined)).toEqual({ ok: true, identityId: null });
  });

  it("treats an empty or blank param as no barry", () => {
    // A picker sitting on "inherit" sends `?identityId=`. Rejecting that would
    // 400 the form's default state.
    expect(parseIdentityIdParam("")).toEqual({ ok: true, identityId: null });
    expect(parseIdentityIdParam("   ")).toEqual({ ok: true, identityId: null });
  });

  it("accepts an integer", () => {
    expect(parseIdentityIdParam("3")).toEqual({ ok: true, identityId: 3 });
  });

  it("rejects a present but unparseable value", () => {
    // Falling back to the full list here would look like scoping silently
    // failed rather than like a bad request.
    expect(parseIdentityIdParam("abc")).toEqual({ ok: false });
    expect(parseIdentityIdParam("3.5")).toEqual({ ok: false });
  });

  it("rejects a repeated param, which arrives as an array", () => {
    expect(parseIdentityIdParam(["3", "4"])).toEqual({ ok: false });
  });
});
