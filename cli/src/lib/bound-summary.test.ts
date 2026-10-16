import { describe, it, expect } from "vitest";
import { summarizeBound, EMPTY_BOUND_SUMMARY } from "./bound-summary.js";

describe("summarizeBound", () => {
  it("names allowed and denied tools (including native tool patterns)", () => {
    expect(
      summarizeBound({
        tools: { allow: ["*:read"], deny: ["*:write", "*:Bash", "claude-code:Write"] },
      }),
    ).toBe("allow tools: *:read · tools: *:write, *:Bash, claude-code:Write");
    expect(summarizeBound({ tools: { allow: [] } })).toBe("allow tools: none");
  });

  it("counts input parameter rules, file patterns, and bash rules instead of listing them", () => {
    expect(
      summarizeBound({
        inputs: { "slack:send_message": { channel_id: { allow: ["U123"] } } },
        files: { deny: ["*.env", "*.pem"] },
        bash: { allow: ["git status*"], deny: ["rm -rf", "git push*", "gh *"] },
      }),
    ).toBe("inputs: 1 tool(s) · files: 2 pattern(s) · allow bash: 1 · bash: 3 rule(s)");
  });

  it("counts denied and allowed network hosts and nodes", () => {
    expect(
      summarizeBound({
        network: { deny: ["*:write", "evil.com"] },
        nodes: { allow: ["mac-studio"], deny: ["untrusted"] },
      }),
    ).toBe("deny hosts: 2 · allow nodes: mac-studio · deny nodes: untrusted");
  });

  // An allowlist restricts by SHRINKING, so an empty one permits nothing —
  // the most restrictive state, not the absence of a rule. Checking presence
  // rather than length is what keeps it from vanishing from the summary.
  it("reports an empty network.allow as 'none' rather than omitting it", () => {
    expect(summarizeBound({ network: { allow: [] } })).toBe("allow hosts: none");
  });

  it("reports an empty files.allow as 'none' rather than omitting it", () => {
    expect(summarizeBound({ files: { allow: [] } })).toBe("allow paths: none");
  });

  it("counts a populated files.allow with its roots", () => {
    expect(summarizeBound({ files: { allow: ["~/repos/vantage/**"] } })).toBe(
      "allow paths: 1",
    );
  });

  it("counts a populated network.allow", () => {
    expect(summarizeBound({ network: { allow: ["a.com", "b.com"] } })).toBe(
      "allow hosts: 2",
    );
  });

  it("names the enforcement mode", () => {
    expect(summarizeBound({ network: { enforce: "sandbox" } })).toBe("enforce: sandbox");
  });

  it("joins every dimension in play", () => {
    const summary = summarizeBound({
      tools: { deny: ["*:Bash"] },
      files: { deny: ["*.key"] },
      network: { deny: ["*:write"], enforce: "guard" },
    });
    expect(summary).toBe("tools: *:Bash · files: 1 pattern(s) · deny hosts: 1 · enforce: guard");
  });

  it("reports an empty bound as restricting nothing", () => {
    expect(summarizeBound({})).toBe(EMPTY_BOUND_SUMMARY);
  });

  it("ignores present-but-empty deny arrays", () => {
    expect(
      summarizeBound({ tools: { deny: [] }, files: { deny: [] }, bash: { deny: [] } }),
    ).toBe(EMPTY_BOUND_SUMMARY);
  });
});

