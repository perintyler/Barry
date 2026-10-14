import { describe, expect, it } from "vitest";
import { identifyCursorTool } from "./acp.js";

describe("cursor's ACP tool calls, as Barry's policy names them", () => {
  it("names an MCP call by its server and tool once cursor says them, with its arguments as input", () => {
    expect(identifyCursorTool({ title: "MCP: tool", kind: "other", rawInput: {} })).toBeUndefined();
    expect(identifyCursorTool({ title: "probe: probe_tool", kind: "other", rawInput: { providerIdentifier: "probe", toolName: "probe_tool", args: { q: 1 } } }))
      .toEqual({ name: "mcp__probe__probe_tool", input: { q: 1 } });
  });

  it("names a native call by its kind, and leaves anything else unnamed for the policy to refuse", () => {
    expect(identifyCursorTool({ title: "`ls -la .`", kind: "execute", rawInput: { command: "ls -la ." } })).toEqual({ name: "Shell", input: { command: "ls -la ." } });
    expect(identifyCursorTool({ title: "Read notes.md", kind: "read", rawInput: { path: "notes.md" } })?.name).toBe("Read");
    expect(identifyCursorTool({ title: "something new", kind: "other" })).toBeUndefined();
    expect(identifyCursorTool({ title: "a think", kind: "think" })).toBeUndefined();
  });
});
it("distinguishes web search from grep by the retained call id", () => {
  expect(identifyCursorTool({ toolCallId: "web_search_1", kind: "search", title: "Search" })?.name).toBe("WebSearch");
  expect(identifyCursorTool({ toolCallId: "grep_1", kind: "search", title: "Search" })?.name).toBe("Grep");
  expect(identifyCursorTool({ kind: "fetch", title: "Fetch" })?.name).toBe("WebFetch");
});
