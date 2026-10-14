import { describe, it, expect } from "vitest";
import { resolveExecutionContext, assertToolAllowed } from "./execution-context.js";
import { mergeBounds } from "./merge-bounds.js";
import { resolveNativePolicy } from "./native-policy.js";
describe("explicit execution permissions", () => {
    it("grants tools across nodes and restricts only selected bounds", async () => {
        const context = await resolveExecutionContext({ traitNames: ["files"], traits: { files: { name: "files", namespaces: ["filesystem"], access: "readwrite" } }, tools: [{ namespace: "filesystem", toolName: "Read", access: "read" }], boundByName: async () => null });
        expect(() => assertToolAllowed(context, { namespace: "filesystem", toolName: "Read" }, "desktop")).not.toThrow();
        context.bound = { nodes: { allow: ["laptop"] } };
        expect(() => assertToolAllowed(context, { namespace: "filesystem", toolName: "Read" }, "desktop")).toThrow(/node/);
    });
    it("has no identity-free default grants", async () => {
        expect((await resolveExecutionContext({ traitNames: [], traits: {}, tools: [{ namespace: "bash", toolName: "Bash", access: "write" }], boundByName: async () => null })).allowedToolIds).toEqual([]);
        await expect(resolveExecutionContext({ traitNames: ["typo"], traits: {}, tools: [], boundByName: async () => null })).rejects.toThrow(/unknown/);
        expect(mergeBounds({ nodes: { allow: ["a"], deny: ["b"] } }, { nodes: { allow: ["c"], deny: ["d"] } })?.nodes).toEqual({ allow: [], deny: ["b", "d"] });
    });
    it("denies native tools when the mode has no control declaration", () => {
        const harness = { id: "codex", nativeTools: ["shell"] };
        expect(resolveNativePolicy({ bound: null, tools: [] }, harness, "guest").denied).toEqual(["shell"]);
        expect(resolveNativePolicy({ bound: null, tools: [] }, harness, "hosted").denied).toEqual(["shell"]);
        expect(resolveNativePolicy({ bound: { nativeTools: { codex: ["shell"] } }, tools: [] }, harness, "hosted").denied).toEqual(["shell"]);
    });
});
