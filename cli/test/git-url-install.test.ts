import { describe, expect, it } from "vitest";
import { looksLikeGitRepoUrl } from "../src/commands/bag.js";

// Reject bare git repository URLs without overwriting local registrations; allow actual MCP endpoint paths.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-036
describe("looksLikeGitRepoUrl", () => {
  it("recognizes a bare repository URL", () => {
    expect(looksLikeGitRepoUrl("https://github.com/perintyler/jalen-brunson")).toBe(true);
  });

  it("recognizes the .git suffix form", () => {
    expect(looksLikeGitRepoUrl("https://github.com/perintyler/jalen-brunson.git")).toBe(true);
  });

  it("covers the other common forges", () => {
    expect(looksLikeGitRepoUrl("https://gitlab.com/owner/name")).toBe(true);
    expect(looksLikeGitRepoUrl("https://bitbucket.org/owner/name")).toBe(true);
    expect(looksLikeGitRepoUrl("https://codeberg.org/owner/name")).toBe(true);
  });

  it("ignores case in the hostname", () => {
    expect(looksLikeGitRepoUrl("https://GitHub.com/owner/name")).toBe(true);
  });

  // The other half of the contract. A guard that refused every URL on a git
  // host would break a legitimate use of this command, so these must pass
  // through -- and each is a real shape someone could be serving MCP from.
  it("allows a deeper path on a git host", () => {
    // Pages, a raw file, an API route -- all plausible MCP endpoints.
    expect(looksLikeGitRepoUrl("https://github.com/owner/name/mcp")).toBe(false);
    expect(looksLikeGitRepoUrl("https://github.com/owner/name/raw/main/server.json")).toBe(false);
  });

  it("allows a git host URL carrying a query or fragment", () => {
    expect(looksLikeGitRepoUrl("https://github.com/owner/name?transport=sse")).toBe(false);
  });

  it("allows an owner-only or host-only URL", () => {
    // Not a repository; nothing to clone, so not this guard's business.
    expect(looksLikeGitRepoUrl("https://github.com/owner")).toBe(false);
    expect(looksLikeGitRepoUrl("https://github.com")).toBe(false);
  });

  it("allows every non-git host", () => {
    expect(looksLikeGitRepoUrl("https://mcp.example.com/owner/name")).toBe(false);
    expect(looksLikeGitRepoUrl("http://127.0.0.1:3868/mcp")).toBe(false);
  });

  it("returns false rather than throwing on an unparseable target", () => {
    // classifyTarget only calls this for http(s)-prefixed strings, but a
    // predicate that throws would turn a bad argument into a stack trace.
    expect(looksLikeGitRepoUrl("not a url")).toBe(false);
    expect(looksLikeGitRepoUrl("")).toBe(false);
  });
});
