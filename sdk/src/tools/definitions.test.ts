import { describe, expect, it } from "vitest";
import { Barry } from "../index.js";
import { toolDefinitions } from "./definitions.js";
const tool = Barry.Tool({ name: "read", namespace: "documents", access: "read", description: "Read documents", schema: {}, handler: async () => "ok" });
describe("exported tool definitions", () => {
  it("deduplicates the same definition exported directly and through an array", () => {
    expect(toolDefinitions({ read: tool, tools: [tool], unrelated: "ignored" })).toEqual([tool]);
  });
  it("rejects separate definitions with the same qualified name", () => {
    expect(() => toolDefinitions({ first: tool, second: { ...tool } })).toThrow(/duplicate exported tool/);
  });
  it("rejects malformed definitions instead of deriving permissive access", () => {
    expect(() => toolDefinitions({ invalid: { ...tool, access: "unknown" } })).toThrow(/invalid exported/);
  });
});
