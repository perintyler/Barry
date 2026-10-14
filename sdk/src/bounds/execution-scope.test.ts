import { describe, it, expect } from "vitest";
import { approveExecutionScope, intersectExecutionScope, assertScopeDelegation } from "./execution-scope.js";
import type { AgentTrait, ToolMeta } from "./types.js";
const catalog: ToolMeta[] = [{ namespace: "documents", toolName: "read", access: "read" }, { namespace: "documents", toolName: "write", access: "write" }, { namespace: "issues", toolName: "read", access: "read" }];
const traits: Record<string, AgentTrait> = { reader: { name: "reader", namespaces: ["documents"], access: "read" } };
const approve = () => approveExecutionScope({ identity: "reviewer", traitNames: ["reader"], traits, tools: catalog, boundByName: async () => undefined });
describe("durable execution ceiling", () => {
  it("retains qualified access despite defaults, namespace collisions and catalog expansion", async () => {
    const grant = await approve();
    const current = { identity: "reviewer", traits: ["reader", "editor"], bound: null, allowedToolIds: ["documents:read", "documents:write", "issues:read"] };
    expect(intersectExecutionScope(grant, current, catalog).allowedToolIds).toEqual(["documents:read"]);
    expect(intersectExecutionScope(grant, current, catalog.map(t => ({ ...t, access: "write" }))).allowedToolIds).toEqual([]);
  });
  it("intersects empty and disjoint allowlists and rejects identity changes", async () => {
    const grant = await approveExecutionScope({ identity: "reviewer", traitNames: ["reader"], traits, tools: catalog, bounds: [{ nodes: { allow: ["a"] } }], boundByName: async () => undefined });
    const context = { identity: "reviewer", traits: [], bound: { nodes: { allow: ["b"] } }, allowedToolIds: ["documents:read"] };
    expect(intersectExecutionScope(grant, context, catalog).bound?.nodes?.allow).toEqual([]);
    expect(() => intersectExecutionScope(grant, { ...context, identity: "other" }, catalog)).toThrow("identity");
    expect(() => assertScopeDelegation(grant, { ...context, bound: null, allowedToolIds: [] }, catalog)).toThrow("delegable");
  });
  it("rejects missing selections and altered evidence", async () => {
    await expect(approveExecutionScope({ traitNames: ["absent"], traits, tools: catalog, boundByName: async () => undefined })).rejects.toThrow("unknown");
    const grant = await approve();
    expect(() => intersectExecutionScope({ ...grant, tools: { "documents:write": "write" } }, { identity: "reviewer", traits: [], bound: null, allowedToolIds: ["documents:write"] }, catalog)).toThrow("fingerprint");
  });
  it("withholds a capability when its pinned contract changes without changing access class", async () => {
    const tools = [{ namespace: "documents", toolName: "read", access: "read" as const, contractHash: "a".repeat(64) }];
    const approved = await approveExecutionScope({ identity: "reviewer", traitNames: ["reader"], traits, tools, boundByName: async () => undefined });
    const current = { identity: "reviewer", traits: ["reader"], bound: null, allowedToolIds: ["documents:read"] };
    expect(intersectExecutionScope(approved, current, tools).allowedToolIds).toEqual(["documents:read"]);
    expect(intersectExecutionScope(approved, current, [{ ...tools[0], contractHash: "b".repeat(64) }]).allowedToolIds).toEqual([]);
  });
});
