import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { resolveRepoUrl } from "../src/bags/git-source.js";

// Deduplicate by bag source including subdirectory so diamonds terminate without skipping sibling bags.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-037
describe("composed children from one monorepo each install", () => {
  const source = readFileSync(
    join(__dirname, "../src/commands/bag.ts"),
    "utf-8",
  );

  it("keys `visited` on the subdir as well as the repo", () => {
    expect(source).toContain(
      "`repo:${resolveRepoUrl(source.repo)}#${source.subdir ?? \"\"}`",
    );
  });

  it("does not key on the repo URL alone", () => {
    // The old expression, which silently dropped every child after the first.
    expect(source).not.toContain("`repo:${resolveRepoUrl(source.repo)}`");
  });

  it("gives sibling bags in one repo distinct keys", () => {
    const key = (s: { repo: string; subdir?: string }) =>
      `repo:${resolveRepoUrl(s.repo)}#${s.subdir ?? ""}`;

    const repo = "vantage-sh/vantage-bags";
    const keys = ["vantage-core", "vantage-infra", "vantage-sdks"].map(subdir =>
      key({ repo, subdir }),
    );

    expect(new Set(keys).size).toBe(3);
  });

  it("still collapses a diamond — same repo and subdir seen twice", () => {
    const key = (s: { repo: string; subdir?: string }) =>
      `repo:${resolveRepoUrl(s.repo)}#${s.subdir ?? ""}`;

    const a = key({ repo: "vantage-sh/vantage-bags", subdir: "vantage-core" });
    // Same bag, spelled as a full URL by a different parent.
    const b = key({
      repo: "https://github.com/vantage-sh/vantage-bags.git",
      subdir: "vantage-core",
    });

    expect(a).toBe(b);
  });

  it("keeps a subdir-less repo child distinct from a subdir one", () => {
    const key = (s: { repo: string; subdir?: string }) =>
      `repo:${resolveRepoUrl(s.repo)}#${s.subdir ?? ""}`;

    expect(key({ repo: "o/r" })).not.toBe(key({ repo: "o/r", subdir: "bag-a" }));
  });
});
