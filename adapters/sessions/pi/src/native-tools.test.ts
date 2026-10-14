import { describe, expect, it } from "vitest";
import { NATIVE_TOOLS } from "./native-tools.js";

describe("Pi Native Tools", () => {
  it("declares the built-in and core extension tool names", () => {
    expect(NATIVE_TOOLS).toEqual([
      "read",
      "bash",
      "powershell",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "codemode",
      "tool_search",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]);
  });

  it("contains unique, non-empty tool names", () => {
    expect(new Set(NATIVE_TOOLS).size).toBe(NATIVE_TOOLS.length);
    for (const name of NATIVE_TOOLS) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
