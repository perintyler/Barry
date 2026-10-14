import { describe, expect, it } from "vitest";
import { NATIVE_TOOLS, allowedNative, disallowedTools } from "./native-tools.js";

describe("native tools on the pinned build", () => {
  it("has no duplicate names and denies the inventory without an allowance", () => {
    expect(new Set(NATIVE_TOOLS).size).toBe(NATIVE_TOOLS.length);
    expect(allowedNative({})).toEqual([]);
    expect(disallowedTools({})).toEqual(NATIVE_TOOLS);
  });
  it("keeps a denial above a grant and ignores unknown allowances", () => {
    const tool = NATIVE_TOOLS[0];
    expect(allowedNative({ allowedNativeTools: [tool, "future_native"], deniedTools: [tool] })).toEqual([]);
  });
});
