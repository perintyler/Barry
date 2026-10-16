import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { BoundedToolInvoker } from "./bounded-invocation.js";
import { approveWorkflowBounds } from "../bounds/workflow-bounds.js";
import type { InvocationAuthority } from "./bounded-invocation.js";
const catalog = [{ namespace: "documents", toolName: "write", contractHash: "a".repeat(64), access: "write" as const }];
async function fixture() {
  const approved = await approveWorkflowBounds({ identity: "reviewer", bags: ["documents"], tools: catalog, boundByName: async () => undefined });
  const current = { identity: "reviewer", bags: ["documents"], traits: ["documents"], bound: null, allowedToolIds: ["documents:write"] };
  return { approved, current, catalog } satisfies InvocationAuthority;
}
describe("bounded destination effects", () => {
  it("delivers narrowed credentials and tool authority through a network-bound Bash wrapper", async () => {
    const tools = [{ namespace: "shell", toolName: "Bash", contractHash: "b".repeat(64), access: "write" as const }];
    const approved = await approveWorkflowBounds({ identity: "reviewer", bags: ["shell"], tools, boundByName: async () => undefined });
    const authority: InvocationAuthority = { approved, current: { identity: "reviewer", bags: ["shell"], traits: ["shell"], bound: { network: { deny: ["write"] } }, allowedToolIds: ["shell:Bash"] }, catalog: tools };
    const db = new DatabaseSync(":memory:");
    try {
      const invoker = new BoundedToolInvoker({ db, node: "node", authorize: async () => authority, credentials: async () => ({ TOKEN: "synthetic", OTHER: "excluded" }), enforceable: () => true, tools: [{ namespace: "shell", name: "Bash", contractHash: "b".repeat(64), access: "write", secrets: ["TOKEN"], parse: input => input as Record<string, unknown>, invoke: async (_params, context) => ({ secrets: context.secrets, tools: context.availableTools }) }] });
      expect(await invoker.invoke({ key: "bash-context", node: "node", tool: "shell:Bash", input: { command: "printf hello" } })).toEqual({ secrets: { TOKEN: "synthetic" }, tools: ["shell:Bash"] });
    } finally { db.close(); }
  });
  it("rechecks live attempt authority after asynchronous policy lookup even on receipt reads", async () => {
    const authority = await fixture(), db = new DatabaseSync(":memory:");
    let effects = 0, active = true, revokeDuringLookup = false;
    const request = { key: "effect", node: "node", tool: "documents:write", input: {} };
    try {
      const invoker = new BoundedToolInvoker({ db, node: "node", authorize: async () => { if (revokeDuringLookup) active = false; return authority; }, credentials: async () => ({}), enforceable: () => true, tools: [{ namespace: "documents", name: "write", contractHash: "a".repeat(64), access: "write", parse: input => input as Record<string, unknown>, invoke: async () => { effects++; return "receipt"; } }] });
      const check = () => { if (!active) throw new Error("attempt revoked"); };
      expect(await invoker.invoke(request, check)).toBe("receipt");
      revokeDuringLookup = true;
      await expect(invoker.invoke(request, check)).rejects.toThrow("attempt revoked");
      expect(effects).toBe(1);
    } finally { db.close(); }
  });
  it("refuses absent contract evidence before acquiring credentials or invoking", async () => {
    const authority = await fixture(), db = new DatabaseSync(":memory:"); let effects = 0, credentialReads = 0;
    try {
      const invoker = new BoundedToolInvoker({ db, node: "node", authorize: async () => authority, credentials: async () => { credentialReads++; return {}; }, enforceable: () => true, tools: [{ namespace: "documents", name: "write", access: "write", parse: input => input as Record<string, unknown>, invoke: async () => { effects++; return null; } }] });
      await expect(invoker.invoke({ key: "effect", node: "node", tool: "documents:write", input: {} })).rejects.toThrow("ToolContractUnavailable");
      expect({ effects, credentialReads }).toEqual({ effects: 0, credentialReads: 0 });
    } finally { db.close(); }
  });
  it("deduplicates physical effects, conflicts changed bodies and denies revoked receipt reads", async () => {
    const authority = await fixture(), db = new DatabaseSync(":memory:"); let effects = 0, secrets: unknown;
    try {
      const invoker = new BoundedToolInvoker({ db, node: "node", authorize: async () => authority, credentials: async () => ({ TOKEN: "synthetic", OTHER: "not-exposed" }), enforceable: () => true, tools: [{ namespace: "documents", name: "write", contractHash: "a".repeat(64), access: "write", secrets: ["TOKEN"], parse: input => input as Record<string, unknown>, invoke: async (_input, context) => { effects++; secrets = context.secrets; return { saved: true }; } }] });
      const request = { key: "effect", node: "node", tool: "documents:write", input: { value: 1 } };
      expect(await invoker.invoke(request)).toEqual({ saved: true });
      expect(await invoker.invoke(request)).toEqual({ saved: true });
      expect(effects).toBe(1); expect(secrets).toEqual({ TOKEN: "synthetic" });
      await expect(invoker.invoke({ ...request, input: { value: 2 } })).rejects.toThrow("conflict");
      authority.current.allowedToolIds = [];
      await expect(invoker.invoke(request)).rejects.toThrow("denied");
      expect(effects).toBe(1);
    } finally { db.close(); }
  });
  it("never repeats a call after a lost effect response or process journal recovery", async () => {
    const authority = await fixture(), db = new DatabaseSync(":memory:"); let effects = 0;
    try {
      const options = { db, node: "node", authorize: async () => authority, credentials: async () => ({}), enforceable: () => true, tools: [{ namespace: "documents", name: "write", contractHash: "a".repeat(64), access: "write" as const, parse: (input: unknown) => input as Record<string, unknown>, invoke: async () => { effects++; throw new Error("lost response after effect"); } }] };
      const request = { key: "effect", node: "node", tool: "documents:write", input: {} };
      await expect(new BoundedToolInvoker(options).invoke(request)).rejects.toMatchObject({ message: expect.stringContaining("OutcomeUnknown"), cause: expect.objectContaining({ message: "lost response after effect" }) });
      await expect(new BoundedToolInvoker(options).invoke(request)).rejects.toThrow("OutcomeUnknown");
      expect(effects).toBe(1);
    } finally { db.close(); }
  });
  it("checks revocation after credential lookup before calling a tool", async () => {
    const authority = await fixture(), db = new DatabaseSync(":memory:"); let effects = 0;
    try {
      const invoker = new BoundedToolInvoker({ db, node: "node", authorize: async () => authority, credentials: async () => { authority.current.allowedToolIds = []; return {}; }, enforceable: () => true, tools: [{ namespace: "documents", name: "write", contractHash: "a".repeat(64), access: "write", parse: input => input as Record<string, unknown>, invoke: async () => { effects++; return null; } }] });
      await expect(invoker.invoke({ key: "effect", node: "node", tool: "documents:write", input: {} })).rejects.toThrow("denied");
      expect(effects).toBe(0);
    } finally { db.close(); }
  });
});
