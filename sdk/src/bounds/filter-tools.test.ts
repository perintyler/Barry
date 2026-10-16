import { describe, it, expect } from "vitest";
import { filterTools, filterToolsQualified } from "./filter-tools.js";
import type { Bound, ToolDescriptor } from "./types.js";

const tools: ToolDescriptor[] = [
  { namespace: "filesystem", toolName: "read", access: "read" },
  { namespace: "filesystem", toolName: "write", access: "write" },
  { namespace: "filesystem", toolName: "edit", access: "write" },
  { namespace: "git", toolName: "status", access: "read" },
  { namespace: "git", toolName: "push", access: "write" },
  { namespace: "sentry", toolName: "search_issues", access: "read" },
  { namespace: "sentry", toolName: "create_issue", access: "write" },
  { namespace: "slack", toolName: "list_channels", access: "read" },
  { namespace: "slack", toolName: "send_message", access: "write" },
  { namespace: "notion", toolName: "read_page", access: "read" },
  { namespace: "notion", toolName: "write_page", access: "write" },
];

describe("filterTools", () => {
  it("returns all tools when bound is null or omitted", () => {
    const allowed = filterTools(tools);
    expect(allowed).toContain("read");
    expect(allowed).toContain("write");
    expect(allowed).toContain("status");
    expect(allowed).toContain("push");
    expect(allowed).toContain("search_issues");
    expect(allowed).toContain("send_message");
  });

  it("tools.deny '<namespace>:*' excludes by namespace", () => {
    const bound: Bound = { tools: { deny: ["filesystem:*"] } };
    const allowed = filterTools(tools, bound);
    expect(allowed).not.toContain("read");
    expect(allowed).not.toContain("write");
    expect(allowed).toContain("status");
  });

  it("tools.deny excludes by toolName", () => {
    const bound: Bound = { tools: { deny: ["write"] } };
    const allowed = filterTools(tools, bound);
    expect(allowed).toContain("read");
    expect(allowed).not.toContain("write");
    expect(allowed).toContain("edit");
  });

  it("tools.deny '<namespace>:write' strips write tools by namespace", () => {
    const bound: Bound = { tools: { deny: ["sentry:write"] } };
    const allowed = filterTools(tools, bound);
    expect(allowed).toContain("search_issues");
    expect(allowed).not.toContain("create_issue");
  });

  it("tools.deny '*:write' blocks all write tools globally", () => {
    const bound: Bound = { tools: { deny: ["*:write"] } };
    const allowed = filterTools(tools, bound);
    expect(allowed).toContain("read");
    expect(allowed).toContain("status");
    expect(allowed).toContain("search_issues");
    expect(allowed).toContain("list_channels");
    expect(allowed).not.toContain("write");
    expect(allowed).not.toContain("edit");
    expect(allowed).not.toContain("push");
    expect(allowed).not.toContain("send_message");
  });

  it("tools.allow restricts to matching patterns and tools.deny wins on conflict", () => {
    const bound: Bound = {
      tools: {
        allow: ["filesystem:*", "git:*", "slack:*"],
        deny: ["send_message", "filesystem:write"],
      },
    };
    const allowed = filterTools(tools, bound);
    expect(allowed).toContain("read");
    expect(allowed).not.toContain("write");
    expect(allowed).not.toContain("edit");
    expect(allowed).toContain("status");
    expect(allowed).toContain("push");
    expect(allowed).toContain("list_channels");
    expect(allowed).not.toContain("send_message");
    expect(allowed).not.toContain("search_issues");
  });

  it("network.deny implies tool denials through the authorization pass", () => {
    const bound: Bound = { network: { deny: ["write"] } };
    const allowed = filterTools(tools, bound);
    expect(allowed).not.toContain("push");
    expect(allowed).toContain("status");
    expect(filterTools(tools)).toContain("push");
  });

  it("filterToolsQualified returns namespace:toolName", () => {
    const qualified = filterToolsQualified(
      [
        { namespace: "git", toolName: "status", access: "read" },
        { namespace: "git", toolName: "push", access: "write" },
      ],
      { tools: { deny: ["*:write"] } },
    );
    expect(qualified).toEqual(["git:status"]);
  });
});

describe("file-bound shell withdrawal", () => {
  const shellTools: ToolDescriptor[] = [
    { toolName: "Bash", namespace: "bash", access: "write" },
    { toolName: "Read", namespace: "filesystem", access: "read" },
  ];
  it.each([{ files: { deny: ["*.env"] } }, { files: { allow: [] } }])(
    "withdraws Bash from the advertised inventory",
    (bound) => {
      expect(filterTools(shellTools, bound)).toEqual(["Read"]);
    },
  );
  it("keeps Bash when no file restriction applies", () =>
    expect(filterTools(shellTools, {})).toEqual(["Bash", "Read"]));
});

describe("tools.deny casing", () => {
  it("denies a capitalised MCP tool named by lower-case in the bound", () => {
    const mixedCaseTools: ToolDescriptor[] = [
      { namespace: "bash", toolName: "Bash", access: "write" },
      { namespace: "git", toolName: "status", access: "read" },
    ];
    const bound: Bound = { tools: { deny: ["bash"] } };
    const names = filterTools(mixedCaseTools, bound);
    expect(names).not.toContain("Bash");
    expect(names).toContain("status");
  });
});
