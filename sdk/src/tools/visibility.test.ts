import { describe, expect, it } from "vitest";
import { Barry } from "../index.js";
import { applyToolVisibility, ToolVisibilitySchema } from "./visibility.js";

describe("tool visibility", () => {
  const tool = Barry.Tool({ name: "read", namespace: "documents", access: "read", description: "Read a document", schema: {}, handler: async () => "document", deferred: true });
  it("applies visibility without mutating code definitions or widening access", () => {
    expect(applyToolVisibility([tool], { read: "deferred" }, { read: "enabled" })[0]).toMatchObject({ deferred: false, access: "read" });
    expect(tool.deferred).toBe(true);
    expect(applyToolVisibility([tool], { read: "disabled" })).toEqual([]);
  });
  it("rejects unknown and duplicate tool names", () => {
    expect(() => applyToolVisibility([tool], { missing: "enabled" })).toThrow(/unknown tool/);
    expect(() => ToolVisibilitySchema.parse([{ read: "enabled" }, { read: "disabled" }])).toThrow(/duplicate/);
    expect(() => ToolVisibilitySchema.parse([{ read: "enabled", write: "disabled" }])).toThrow(/exactly one/);
  });
});
