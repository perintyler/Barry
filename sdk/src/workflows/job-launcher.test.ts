import { describe, it, expect } from "vitest";
import { boundToNodeFlags } from "./job-launcher.js";

const home = "/Users/me";
const literal = () => undefined;

describe("boundToNodeFlags", () => {
  it("grants no files for an empty allowlist, and never a child process", () => {
    expect(boundToNodeFlags({ files: { allow: [] } }, home, literal)).toEqual({ flags: ["--permission", "--allow-net"] });
  });

  it("grants each allowed directory, however its pattern ends", () => {
    expect(boundToNodeFlags({ files: { allow: ["~/repos/notes/**", "/tmp/out/*", "/etc/hosts"] } }, home, literal)).toEqual({
      flags: [
        "--permission", "--allow-net",
        "--allow-fs-read=/Users/me/repos/notes", "--allow-fs-write=/Users/me/repos/notes",
        "--allow-fs-read=/tmp/out", "--allow-fs-write=/tmp/out",
        "--allow-fs-read=/etc/hosts", "--allow-fs-write=/etc/hosts",
      ],
    });
  });

  it("drops writes when the bound denies them", () => {
    expect(boundToNodeFlags({ tools: { deny: ["*:write"] }, files: { allow: ["/data"] } }, home, literal)).toEqual({
      flags: ["--permission", "--allow-net", "--allow-fs-read=/data"],
    });
    expect(boundToNodeFlags({ tools: { deny: ["*:write", "x"] } }, home, literal)).toEqual({
      flags: ["--permission", "--allow-net", "--allow-fs-read=*"],
    });
  });

  it("refuses what Node cannot express", () => {
    for (const allow of [["*.md"], ["notes/**"], ["/a/**/b"], ["/a/b*"]]) {
      expect(boundToNodeFlags({ files: { allow } }, home, literal)).toHaveProperty("refused");
    }
    expect(boundToNodeFlags({ files: { deny: ["/secrets"] } }, home, literal)).toEqual({ refused: expect.stringMatching(/files\.deny/) });
    expect(boundToNodeFlags({ network: { deny: ["write"] } }, home, literal)).toEqual({ refused: expect.stringMatching(/network/) });
    expect(boundToNodeFlags({ network: { enforce: "sandbox" } }, home, literal)).toHaveProperty("refused");
  });

  it("grants a path under its resolved spelling too", () => {
    expect(boundToNodeFlags({ tools: { deny: ["*:write"] }, files: { allow: ["/var/data"] } }, home, (p) => `/private${p}`)).toEqual({
      flags: ["--permission", "--allow-net", "--allow-fs-read=/var/data", "--allow-fs-read=/private/var/data"],
    });
  });

  it("holds bash restrictions by granting no child process at all", () => {
    const result = boundToNodeFlags({ bash: { deny: ["git"] }, files: { allow: [] } }, home, literal);
    expect(result).toEqual({ flags: ["--permission", "--allow-net"] });
  });
});
