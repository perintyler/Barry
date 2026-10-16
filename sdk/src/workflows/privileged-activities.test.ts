import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WorkflowOwner } from "./workflow-owner.js";
import { ActivityWorker } from "./activity-worker.js";
import { activity } from "./types.js";
import { connectOwnerV2, dispatchWorkerRequest } from "./protocol.js";
import { toolActivity, sessionTurnActivity } from "./privileged-activities.js";
import { authorizeRun } from "./approvals.js";
import { approveWorkflowBounds } from "../bounds/workflow-bounds.js";
import { BoundedToolInvoker } from "../tools/bounded-invocation.js";
import { WorkflowSessionTurns, type TurnState } from "../sessions/workflow-turns.js";
import { MemoryWorkflowSessionJournal } from "../sessions/test-helpers/memory-workflow-journal.js";

const sessionJournalSchema = `CREATE TABLE session_workflow_bindings(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,scope_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','ready'))); CREATE TABLE session_workflow_turns(key TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','active','uncertain','interrupting','interrupted','complete')),result TEXT); CREATE UNIQUE INDEX session_workflow_active_turn ON session_workflow_turns(session_id) WHERE state IN ('admitted','active','uncertain','interrupting');`;

it("records a session dependency before creation and blocks a lost creation response", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(sessionJournalSchema);
  const scope = await approveWorkflowBounds({ identity: "identity", bags: [], tools: [], boundByName: async () => undefined });
  const owner = new WorkflowOwner({ id: "owner", path: ":memory:", definitions: [{ type: "review", version: "1", *run() { return yield activity("session.turn@1", null); } }] });
  let creates = 0, turns = 0;
  const sessions = new Map<string, { identity: string; boundFingerprint: string }>();
  const journal = new WorkflowSessionTurns(new MemoryWorkflowSessionJournal(), {
    enforceable: () => true,
    lookupSession: async id => sessions.get(id),
    createSession: async request => {
      // The source already knows which external resource may exist.
      expect(owner.resources("run").bindings[0]).toMatchObject({ sessionId: request.id, state: "active" });
      creates++;
      sessions.set(request.id, { identity: request.identity, boundFingerprint: request.scope.fingerprint });
      throw new Error("creation acknowledgement lost");
    },
    lookupTurn: async () => undefined,
    runTurn: async () => { turns++; return null; },
    interruptTurn: async () => false,
  });
  const worker = new ActivityWorker({ connections: [connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, "worker", request))], activities: { "session.turn@1": sessionTurnActivity({ owner, worker: "worker", sessions: journal }) } });
  try {
    const job = { identity: "identity", bags: [] };
    owner.start({ id: "run", type: "review", version: "1", input: null, job }, "author", undefined, await authorizeRun(job, "author", async () => scope));
    await expect.poll(async () => { await worker.tick(); return owner.get("run").status; }).toBe("blocked");
    expect(owner.get("run").error).toMatch(/^OutcomeUnknown/);
    expect({ creates, turns }).toEqual({ creates: 1, turns: 0 });
    expect(owner.resources("run").bindings).toHaveLength(1);
  } finally { await worker.drain(1000); owner.close(); db.close(); }
});

it("executes a granted tool and identity-backed turn through durable owner/worker protocols", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(sessionJournalSchema);
  const scope = await approveWorkflowBounds({ identity: "identity", bags: ["documents"], tools: [{ namespace: "documents", toolName: "read", contractHash: "a".repeat(64), access: "read" }], boundByName: async () => undefined });
  const owner = new WorkflowOwner({ id: "owner", path: ":memory:", definitions: [{ type: "review", version: "1", *run() { const document = yield activity("documents.read@1", {}); return yield activity("session.turn@1", document); } }] });
  let calls = 0, creations = 0, turns = 0;
  const sessions = new Map<string, { identity: string; boundFingerprint: string }>();
  const results = new Map<string, TurnState>();
  const journal = new WorkflowSessionTurns(new MemoryWorkflowSessionJournal(), {
    enforceable: () => true,
    lookupSession: async id => sessions.get(id),
    createSession: async request => { creations++; sessions.set(request.id, { identity: request.identity, boundFingerprint: request.scope.fingerprint }); },
    lookupTurn: async (_id, key) => results.get(key),
    runTurn: async request => { turns++; const result = { reviewed: request.input }; results.set(request.turnId, { state: "complete", result }); return result; },
    interruptTurn: async () => false,
  });
  const invoker = new BoundedToolInvoker({ db, node: "destination", tools: [{ namespace: "documents", name: "read", contractHash: "a".repeat(64), access: "read", parse: input => input as Record<string, unknown>, invoke: async () => { calls++; return { document: "content" }; } }], credentials: async () => ({}), enforceable: () => true, authorize: async () => ({ approved: scope, current: { identity: scope.identity, bags: scope.bags, traits: scope.traits, bound: scope.bound, allowedToolIds: Object.keys(scope.tools) }, catalog: [{ namespace: "documents", toolName: "read", contractHash: "a".repeat(64), access: "read" }] }) });
  const worker = new ActivityWorker({ connections: [connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, "worker", request))], activities: { "documents.read@1": toolActivity({ owner, worker: "worker", node: "destination", tool: "documents:read", invoker }), "session.turn@1": sessionTurnActivity({ owner, worker: "worker", sessions: journal }) } });
  try {
    const job = { identity: "identity", bags: ["documents"] };
    const grant = await authorizeRun(job, "author", async () => scope);
    owner.start({ id: "run", type: "review", version: "1", input: null, job }, "author", undefined, grant);
    await expect.poll(async () => { await worker.tick(); return owner.get("run").status; }).toBe("completed");
    expect(owner.get("run").outcome).toEqual({ ok: true, value: { reviewed: { document: "content" } } });
    expect({ calls, creations, turns }).toEqual({ calls: 1, creations: 1, turns: 1 });
    expect(owner.resources("run").bindings[0]).toMatchObject({ state: "complete" });
    expect(owner.resources("run").physicalRunning).toBe(0);
  } finally { await worker.drain(1000); owner.close(); db.close(); }
});
