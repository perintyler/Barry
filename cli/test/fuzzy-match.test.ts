import { describe, it, expect } from "vitest";
import { fuzzyMatch, filterAndRank } from "../src/prompts/fuzzy-match.js";

/**
 * What the session picker shows when you type.
 *
 * The picker filtered on `includes` before this, so the risk these tests guard
 * is a silent regression back toward it — or past it. Two failures matter to
 * the user and neither surfaces as an error: an item they can see becomes
 * unreachable by typing, or the item they meant stops being the top row and
 * they select the wrong one off muscle memory.
 *
 * These drive `filterAndRank`, the same function the picker calls, so the
 * ordering asserted here is the ordering rendered. Ranking is asserted as
 * ORDER between candidates, never as absolute scores — the constants are meant
 * to be tunable, and a test pinning them would fail on every tune while
 * proving nothing about what the user sees.
 */

const item = (name: string, description = "") => ({ name, description });

/** Names of what the picker would show, in the order it would show them. */
const shown = (query: string, items: Array<{ name: string; description?: string }>) =>
  filterAndRank(
    query,
    items.map((t) => item(t.name, t.description)),
  ).map((t) => t.name);

describe("filterAndRank", () => {
  it("finds an item from initials, which substring filtering could not", () => {
    expect(shown("atd", [item("amazon-trade-desk"), item("linear")])).toEqual([
      "amazon-trade-desk",
    ]);
  });

  it("still finds the plain substrings that used to work", () => {
    expect(shown("trade", [item("amazon-trade-desk"), item("linear")])).toEqual([
      "amazon-trade-desk",
    ]);
  });

  it("ignores case in both directions", () => {
    expect(shown("ATD", [item("amazon-trade-desk")])).toEqual(["amazon-trade-desk"]);
    expect(shown("linear", [item("LINEAR")])).toEqual(["LINEAR"]);
  });

  it("drops items whose letters are absent or out of order", () => {
    const items = [item("amazon-trade-desk"), item("linear")];
    expect(shown("xyzq", items)).toEqual([]);
    // Right letters, wrong order — a subsequence must be in sequence.
    expect(shown("dta", [item("amazon-trade-desk")])).toEqual([]);
  });

  it("shows every item, in the given order, when nothing is typed", () => {
    const items = [item("scout"), item("git"), item("linear")];
    expect(shown("", items)).toEqual(["scout", "git", "linear"]);
  });

  /**
   * Ranking cases hold NAME LENGTH EQUAL between the candidates.
   *
   * An earlier version of these tests did not, and every one of them passed
   * with all three ranking bonuses zeroed — the length tiebreak alone decided
   * them, because the right answer was always also the shorter string. They
   * asserted the correct order for the wrong reason. Equal lengths make
   * structure the only thing left that can decide, so zeroing the bonuses now
   * turns these red.
   */
  it("ranks a prefix match above a match buried mid-word", () => {
    expect(shown("git", [item("legit-toolkit"), item("git-tool-kits")])[0]).toBe(
      "git-tool-kits",
    );
  });

  it("ranks word-boundary initials above the same letters mid-word", () => {
    // Both names have EQUAL LENGTH and the query matches at the SAME indices in
    // each, so the gap penalty and length term cancel exactly. The only thing
    // left that can decide is the word-boundary bonus — which is what makes
    // typing initials find the hyphenated item you meant.
    const winner = "zz-t-d-k-zz";
    const loser = "zzztzdzkzzz";
    expect(shown("tdk", [item(loser), item(winner)])[0]).toBe(winner);
  });

  it("ranks a contiguous run above the same letters spread apart", () => {
    // Equal length, and neither has a prefix or word-boundary hit, so the
    // consecutive-run bonus is what separates them.
    expect(shown("lin", [item("zlzizn-zzzzz"), item("zzlin-zzzzzz")])[0]).toBe(
      "zzlin-zzzzzz",
    );
  });

  it("prefers the shorter of two matches that are otherwise equal", () => {
    // Length is the intended tiebreak — asserted on its own, with structure
    // held equal (both are prefix matches), so it cannot stand in for the
    // structural bonuses above.
    expect(shown("git", [item("git-extended-toolkit"), item("git")])[0]).toBe("git");
  });

  it("matches descriptions, so an item is reachable by what it does", () => {
    const items = [
      item("scout", "search past conversations"),
      item("git", "version control"),
    ];
    expect(shown("conversations", items)).toEqual(["scout"]);
  });

  it("ranks every name match above any description match", () => {
    // "git" matches the scout row's description, but the item actually named
    // git must come first — otherwise typing an item's exact name selects
    // something else.
    const items = [
      item("scout", "search git history and conversations"),
      item("git", "version control"),
    ];
    expect(shown("git", items)).toEqual(["git", "scout"]);
  });

  it("highlights only names the query actually touched", () => {
    const items = [
      item("scout", "search git history"),
      item("git", "version control"),
    ];
    const results = filterAndRank("git", items);

    const byName = results.find((r) => r.name === "git");
    expect(byName?.matchIndices).toEqual([0, 1, 2]);

    // Present on its description, so nothing in its name should be highlighted.
    const byDescription = results.find((r) => r.name === "scout");
    expect(byDescription?.matchIndices).toBeUndefined();
  });
});

describe("fuzzyMatch", () => {
  it("reports matched positions that line up with the query", () => {
    const match = fuzzyMatch("atd", "amazon-trade-desk");
    expect(match).not.toBeNull();
    // Every reported index holds the character it claims to have matched.
    const chars = match!.indices.map((i) => "amazon-trade-desk"[i]).join("");
    expect(chars).toBe("atd");
    // Ascending, so the renderer can walk them in one pass.
    expect([...match!.indices].sort((a, b) => a - b)).toEqual(match!.indices);
  });

  it("treats an empty query as no filter rather than no matches", () => {
    const match = fuzzyMatch("", "linear");
    expect(match).not.toBeNull();
    expect(match!.indices).toEqual([]);
  });
});
