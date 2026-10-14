import { describe, it, expect } from "vitest";
import { WorkflowOwner } from "./workflow-owner.js";
import { activity } from "./types.js";
import { authorizeRun } from "./grants.js";
import { approveExecutionScope } from "../bounds/execution-scope.js";

const job = { traits: ["reader"], identity: "reviewer" };
const approve = () => approveExecutionScope({ identity: "reviewer", traitNames: ["reader"], traits: { reader: { name: "reader", namespaces: ["documents"], access: "read" } }, tools: [{ namespace: "documents", toolName: "read", access: "read" }], boundByName: async () => undefined });
function owner() { return new WorkflowOwner({ id: "owner", path: ":memory:", definitions: [{ type: "review", version: "1", *run() { yield activity("review", {}); return null; } }] }); }
describe("durable job grants", () => {
  it("requires authorization, persists approved authority, fences effects and preserves submission identity", async () => {
    const runtime = owner();
    try {
      const request = { id: "r", type: "review", version: "1", input: null, job };
      expect(() => runtime.start(request, "author")).toThrow("approved");
      const grant = await authorizeRun(job, "author", async () => approve(), 100);
      const run = runtime.start(request, "author", undefined, grant);
      expect(run.job).toMatchObject({ identity: "reviewer", grantRevision: 1, authorizer: "author" });
      expect(runtime.start(request, "author", undefined, { ...grant, approvedAt: 101 })).toEqual(run);
      runtime.advertise("worker", { types: ["review"], capacity: 1 });
      const task = runtime.claim("worker")!;
      expect(task.grantRevision).toBe(1);
      expect(runtime.effectAuthority("worker", task.token, 1).grant.scope.tools).toEqual({ "documents:read": "read" });
      runtime.cancel("r");
      expect(() => runtime.effectAuthority("worker", task.token, 1)).toThrow("authority");
    } finally { runtime.close(); }
  });
  it("requires settled work for reauthorization and records repeatable receipts", async () => {
    const runtime = owner();
    try {
      const grant = await authorizeRun(job, "author", async () => approve(), 100);
      runtime.start({ id: "r", type: "review", version: "1", input: null, job }, "author", undefined, grant);
      const revision = runtime.get("r").revision;
      const updated = { ...grant, revision: 2, reason: "Explicit operator approval" };
      const result = runtime.reauthorize("r", updated, "change", revision, "author");
      expect(result.job?.grantRevision).toBe(2);
      expect(runtime.reauthorize("r", updated, "change", revision, "author")).toEqual(result);
      runtime.advertise("worker", { types: ["review"], capacity: 1 }); runtime.claim("worker");
      expect(() => runtime.reauthorize("r", { ...updated, revision: 3 }, "change2", runtime.get("r").revision, "author")).toThrow("Settle");
    } finally { runtime.close(); }
  });
  it("does not mistake revoked leases for physical settlement", async () => {
    const runtime = owner();
    try {
      const grant = await authorizeRun(job, "author", async () => approve(), 100);
      runtime.start({ id: "r", type: "review", version: "1", input: null, job }, "author", undefined, grant);
      runtime.advertise("worker", { types: ["review"], capacity: 1 });
      const task = runtime.claim("worker")!;
      runtime.blockExecution("r", "PolicyRevoked");
      expect(runtime.resources("r")).toMatchObject({ logicalLeases: 0, physicalUnknown: 1 });
      const updated = { ...grant, revision: 2, reason: "Reviewed current authority" };
      expect(() => runtime.reauthorize("r", updated, "change", runtime.get("r").revision, "author")).toThrow("Settle");
      expect(runtime.settlePhysical("other-worker", task.token)).toBe(false);
      expect(runtime.completeStatus("worker", task.token, { ok: true, value: null })).toBe("stale");
      expect(runtime.resources("r").physicalUnknown).toBe(0);
      expect(runtime.reauthorize("r", updated, "change", runtime.get("r").revision, "author").job?.grantRevision).toBe(2);
    } finally { runtime.close(); }
  });
  it("scopes indexed identity/profile pages and rejects cursors from different filters", async () => {
    const runtime = owner();
    try {
      const grant = await authorizeRun(job, "author", async () => approve(), 100);
      for (const id of ["one", "two"]) runtime.start({ id, type: "review", version: "1", input: null, job }, "author", undefined, grant);
      const page = runtime.listPage({ identity: "reviewer", creator: "author", profile: "portable", limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      expect(runtime.listPage({ identity: "reviewer", creator: "author", profile: "portable", limit: 1, cursor: page.nextCursor! }).items).toHaveLength(1);
      expect(() => runtime.listPage({ identity: "other", cursor: page.nextCursor! })).toThrow("cursor scope");
      expect(runtime.listPage({ identity: "reviewer", principal: "other" }).items).toEqual([]);
      expect(runtime.listPage({ profile: "resource-contained" }).items).toEqual([]);
    } finally { runtime.close(); }
  });
  it("keeps the creator distinct from an operator who deliberately reauthorizes", async () => {
    const runtime = new WorkflowOwner({ id: "owner", path: ":memory:", definitions: [{ type: "review", version: "1", *run() { return yield activity("review", {}); } }], authorize: run => run.authorizer === "operator" });
    try {
      const grant = await authorizeRun(job, "author", async () => approve(), 100);
      runtime.start({ id: "r", type: "review", version: "1", input: null, job }, "author", undefined, grant);
      runtime.advertise("worker", { types: ["review"], capacity: 1 });
      expect(runtime.claim("worker")).toBeNull();
      const updated = { ...grant, authorizer: "operator", revision: 2, reason: "Explicit administrative approval" };
      runtime.reauthorize("r", updated, "change", runtime.get("r").revision, "operator");
      runtime.resume("r", "operator");
      expect(runtime.claim("worker")).not.toBeNull();
      expect(runtime.get("r")).toMatchObject({ principal: "author", job: { createdBy: "author", authorizer: "operator" } });
    } finally { runtime.close(); }
  });
});
