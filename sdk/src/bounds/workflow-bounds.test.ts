import { describe, it, expect } from "vitest";
import {
  approveWorkflowBounds,
  approvedBoundsSchema,
  intersectWorkflowBounds,
  assertBoundDelegation,
} from "./workflow-bounds.js";
import type { ToolDescriptor } from "./types.js";
const catalog: ToolDescriptor[] = [{ namespace: "documents", toolName: "read", access: "read" }, { namespace: "documents", toolName: "write", access: "write" }, { namespace: "issues", toolName: "read", access: "read" }];
const approve = () => approveWorkflowBounds({ identity: "reviewer", bags: ["documents:read"], tools: catalog, boundByName: async () => undefined });
describe("durable execution ceiling", () => {
  it("retains qualified access despite defaults, namespace collisions and catalog expansion", async () => {
    const grant = await approve();
    expect(grant.version).toBe(2);
    const current = { identity: "reviewer", bags: ["documents", "issues"], traits: ["documents", "issues"], bound: null, allowedToolIds: ["documents:read", "documents:write", "issues:read"] };
    expect(intersectWorkflowBounds(grant, current, catalog).allowedToolIds).toEqual(["documents:read"]);
    expect(intersectWorkflowBounds(grant, current, catalog.map(t => ({ ...t, access: "write" }))).allowedToolIds).toEqual([]);
  });
  it("approves workflow bounds with bags and bounds (without traits) and dual-reads version 1", async () => {
    const approved = await approveWorkflowBounds({
      identity: "reviewer",
      bagNames: ["documents"],
      tools: catalog,
      bounds: ["documents:read"],
      boundByName: async (name) =>
        name === "documents:read" ? { tools: { deny: ["documents:write"] } } : undefined,
    });
    expect(approved.version).toBe(2);
    expect(approved.bags).toEqual(["documents"]);
    expect(approved.tools).toEqual({ "documents:read": "read" });
    expect(approvedBoundsSchema.parse({ ...approved, version: 1 }).version).toBe(1);
  });
  it("intersects empty and disjoint allowlists and rejects identity changes", async () => {
    const grant = await approveWorkflowBounds({ identity: "reviewer", bags: ["documents:read"], tools: catalog, bounds: [{ nodes: { allow: ["a"] } }], boundByName: async () => undefined });
    const context = { identity: "reviewer", bags: ["documents"], traits: ["documents"], bound: { nodes: { allow: ["b"] } }, allowedToolIds: ["documents:read"] };
    expect(intersectWorkflowBounds(grant, context, catalog).bound?.nodes?.allow).toEqual([]);
    expect(() => intersectWorkflowBounds(grant, { ...context, identity: "other" }, catalog)).toThrow("identity");
    expect(() => assertBoundDelegation(grant, { ...context, bound: null, allowedToolIds: [] }, catalog)).toThrow("delegable");
  });
  it("rejects missing selections and altered evidence", async () => {
    await expect(approveWorkflowBounds({ bags: ["documents"], bounds: ["absent"], tools: catalog, boundByName: async () => undefined })).rejects.toThrow("unknown");
    const grant = await approve();
    expect(() => intersectWorkflowBounds({ ...grant, tools: { "documents:write": "write" } }, { identity: "reviewer", bags: ["documents"], traits: ["documents"], bound: null, allowedToolIds: ["documents:write"] }, catalog)).toThrow("fingerprint");
  });
  it("withholds a capability when its pinned contract changes without changing access class", async () => {
    const tools = [{ namespace: "documents", toolName: "read", access: "read" as const, contractHash: "a".repeat(64) }];
    const approved = await approveWorkflowBounds({ identity: "reviewer", bags: ["documents:read"], tools, boundByName: async () => undefined });
    const current = { identity: "reviewer", bags: ["documents"], traits: ["documents"], bound: null, allowedToolIds: ["documents:read"] };
    expect(intersectWorkflowBounds(approved, current, tools).allowedToolIds).toEqual(["documents:read"]);
    expect(intersectWorkflowBounds(approved, current, [{ ...tools[0], contractHash: "b".repeat(64) }]).allowedToolIds).toEqual([]);
  });
});

