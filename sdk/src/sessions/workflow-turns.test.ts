import { describe, it, expect } from "vitest";
import { SessionReconciliationRequired, WorkflowSessionTurns, type TurnState, type WorkflowSessionBackend } from "./workflow-turns.js";
import { approveExecutionScope } from "../bounds/execution-scope.js";
import { MemoryWorkflowSessionJournal } from "./test-helpers/memory-workflow-journal.js";
describe("durable workflow sessions", () => {
  it("reconciles lost turn responses and preserves one physical turn across journal reconstruction", async () => {
    const store = new MemoryWorkflowSessionJournal();
    const sessions = new Map<string, { identity: string; scopeFingerprint: string }>(), turns = new Map<string, TurnState>();
    let creates = 0, deliveries = 0;
    const scope = await approveExecutionScope({ identity: "reviewer", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
    const backend: WorkflowSessionBackend = { lookupSession: async id => sessions.get(id), createSession: async r => { creates++; sessions.set(r.id, { identity: r.identity, scopeFingerprint: r.scope.fingerprint }); }, lookupTurn: async (_id, key) => turns.get(key), runTurn: async r => { deliveries++; turns.set(r.turnId, { state: "complete", result: "review" }); throw new Error("lost acknowledgement"); }, interruptTurn: async () => false, enforceable: () => true };
    {
      const journal = new WorkflowSessionTurns(store, backend), id = await journal.ensure("binding", scope);
      expect(await journal.ensure("binding", scope)).toBe(id);
      await expect(journal.turn("turn", id, "review", scope)).rejects.toMatchObject({ message: expect.stringContaining("OutcomeUnknown"), cause: expect.objectContaining({ message: "lost acknowledgement" }) });
      expect(await new WorkflowSessionTurns(store, backend).turn("turn", id, "review", scope)).toBe("review");
      expect(creates).toBe(1); expect(deliveries).toBe(1);
      await expect(journal.turn("turn", id, "changed", scope)).rejects.toThrow("conflict");
      await expect(journal.inspect("turn")).resolves.toMatchObject({ state: "complete", sessionId: id });
      sessions.set(id, { identity: "different-identity", scopeFingerprint: scope.fingerprint });
      await expect(journal.turn("turn", id, "review", scope)).rejects.toThrow("identity or execution ceiling mismatch");
      expect(deliveries).toBe(1);
      sessions.delete(id);
      await expect(journal.turn("turn", id, "review", scope)).rejects.toThrow("OutcomeUnknown");
    }
  });
  it("retains unknown liveness and serializes turns without closing the continuing session", async () => {
    const store = new MemoryWorkflowSessionJournal();
    const scope = await approveExecutionScope({ identity: "reviewer", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
    let deliveries = 0, interrupted = false, found = false;
    const backend: WorkflowSessionBackend = { lookupSession: async () => found ? { identity: "reviewer", scopeFingerprint: scope.fingerprint } : undefined, createSession: async () => { found = true; }, lookupTurn: async () => interrupted ? { state: "interrupted" } : { state: "uncertain" }, runTurn: async () => { deliveries++; throw new Error("unknown liveness"); }, interruptTurn: async () => { interrupted = true; return true; }, enforceable: () => true };
    {
      const journal = new WorkflowSessionTurns(store, backend), id = await journal.ensure("binding", scope);
      await expect(journal.turn("turn", id, null, scope)).rejects.toThrow("OutcomeUnknown");
      await expect(journal.turn("turn", id, null, scope)).rejects.toThrow("OutcomeUnknown");
      await expect(journal.turn("other-turn", id, null, scope)).rejects.toThrow("SessionBusy");
      expect(deliveries).toBe(1);
      expect(await journal.interrupt("turn")).toBe(true);
      expect(found).toBe(true);
    }
  });

  it("does not duplicate or recursively retry a session create racing another admission", async () => {
    const store = new MemoryWorkflowSessionJournal();
    const sessions = new Map<string, { identity: string; scopeFingerprint: string }>();
    const scope = await approveExecutionScope({ identity: "reviewer", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
    let creates = 0, releaseCreate!: () => void, markCreating!: () => void;
    const creating = new Promise<void>(resolve => { markCreating = resolve; });
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    const backend: WorkflowSessionBackend = {
      lookupSession: async id => sessions.get(id),
      createSession: async request => { creates++; markCreating(); await createGate; sessions.set(request.id, { identity: request.identity, scopeFingerprint: request.scope.fingerprint }); },
      lookupTurn: async () => undefined, runTurn: async () => undefined, interruptTurn: async () => false, enforceable: () => true,
    };
    {
      const journal = new WorkflowSessionTurns(store, backend);
      const first = journal.ensure("binding", scope);
      await creating;
      await expect(journal.ensure("binding", scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
      releaseCreate();
      const id = await first;
      expect(await journal.ensure("binding", scope)).toBe(id);
      expect(creates).toBe(1);
    }
    releaseCreate();
  });
});
