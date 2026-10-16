import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { WorkflowSessionTurns, workflowSessionId, SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import type { ContinuationDescriptor, ContinuationHarness } from "@barry-rocks/sdk/sessions";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { SessionsWorkflowBackend } from "./workflow-session-backend.js";

// Protocol regressions use actual Sessions SQLite/TurnExecution and controlled
// durable harness callbacks. Handles/probes below are synthetic; native/Pi
// cessation is qualified separately in the CLI process integration tests.
let root: string;
beforeEach(() => { closeSessionsDb();root = mkdtempSync(join(tmpdir(), "workflow-backend-protocol-"));vi.stubEnv("BARRY_SESSIONS_DB", join(root, "sessions.db")); });
afterEach(() => { closeSessionsDb();vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true }); });
function gate() { let release!: () => void;const promise = new Promise<void>(resolve => { release = resolve; });return { promise, release }; }
const evidence = { identity: "protocol-identity", traits: [], bound: null, harness: "fixture", tools: { "fixture:effect": "write" as const }, contracts: { "fixture:effect": "a".repeat(64) } };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const checkpoint: ContinuationDescriptor = { format: "fixture.protocol", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "original", payload: { original: true } };
const call = { id: "original-effect", tool: "fixture:effect", input: { original: true } };

function fixture(mode: "deadline" | "revocation" | "effect") {
  const db = getSessionsSqlite(), bindingKey = "protocol/binding", key = "protocol/turn";
  const declaration = { bindingKey, sessionId: workflowSessionId(bindingKey, scope.identity!), identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "fixture", model: "unit/model", endpoint: "unit-endpoint", cwd: root, maxTurns: 2, deadline: Date.now() + (mode === "deadline" ? 1000 : 60000) } };
  const restored = gate(), authorization = gate(), allowAuthorization = gate(), restoreGate = gate(), effectGate = gate();
  let authority = true, prepares = 0, effects = 0, interrupts = 0;
  const backend = new SessionsWorkflowBackend({ db, declaration,
    enforceable: candidate => boundFingerprint(candidate) === boundFingerprint(scope),
    authorize: async () => { if (!authority) throw new Error("Current authority revoked"); },
    authorizeTool: async () => {
      if (mode === "revocation") { authorization.release();await allowAuthorization.promise; }
      return { allow: true };
    },
    prepare: async () => {
      prepares++;
      const harness: ContinuationHarness = { approvalContinuation: "durable",
        validate: descriptor => { expect(descriptor).toEqual(checkpoint); },
        begin: async () => ({ type: "interrupted", continuation: checkpoint, calls: [call] }),
        restore: async (_descriptor, decisions, executor) => {
          expect(decisions.get(call.id)).toEqual({ allow: true });restored.release();
          if (mode === "deadline") { await restoreGate.promise;return { type: "completed", result: "late logical result" }; }
          if (mode === "effect") {
            await effectGate.promise;
            await executor.execute(call, async () => { effects++;return { id: call.id, result: "effect ran" }; });
            return { type: "completed", result: "finished" };
          }
          const decision = await executor.authorize(call);
          if (decision.allow) await executor.execute(call, async () => { effects++;return { id: call.id, result: "effect ran" }; });
          return { type: "completed", result: "finished" };
        },
        interrupt: async () => { interrupts++;restoreGate.release(); },close: async () => {},
      };
      return { handle: { kind: "process", pid: 50000 + prepares, pgid: 50000 + prepares, pidStartedAt: 1, hostname: "synthetic-unit-host", bootIdentity: "synthetic-unit-boot" },
        activate: async () => harness, proveCessation: async () => true, dispose: async () => {} };
    },
  });
  const turns = new WorkflowSessionTurns(workflowTurnsStore, backend);
  return { db, backend, turns, declaration, key, restored: restored.promise, authorization: authorization.promise,
    revoke: () => { authority = false;allowAuthorization.release(); },
    revokeEffect: () => { authority = false;effectGate.release(); },
    get counts() { return { prepares, effects, interrupts }; },
    close: async () => { allowAuthorization.release();restoreGate.release();effectGate.release();await backend.close(); },
  };
}

it("keeps the original whole-turn deadline armed across an automatically approved successor segment", async () => {
  const f = fixture("deadline");
  try {
    const id = await f.turns.ensure(f.declaration.bindingKey, scope);
    const operation = f.turns.turn(f.key, id, { text: "original" }, scope).then(() => null, error => error);
    await f.restored;
    await expect.poll(() => f.counts.interrupts, { timeout: 3000 }).toBeGreaterThan(0);
    await expect.poll(async () => await f.backend.lookupTurn(id, f.key), { timeout: 3000 }).toEqual({ state: "interrupted" });
    expect(await operation).toBeInstanceOf(SessionReconciliationRequired);
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.settlements(mapping.turnId)).toHaveLength(2);
    expect(f.backend.destination.unsettled()).toEqual([]);
    expect(f.counts.prepares).toBe(2);expect(f.counts.effects).toBe(0);
  } finally { await f.close(); }
}, 5000);

it("refuses a recorded tool effect when authority is revoked after approval and successor activation", async () => {
  const f = fixture("effect");
  try {
    const id = await f.turns.ensure(f.declaration.bindingKey, scope);
    const operation = f.turns.turn(f.key, id, { text: "original" }, scope).then(() => null, error => error);
    await f.restored;f.revokeEffect();
    expect(await operation).toBeInstanceOf(SessionReconciliationRequired);
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.counts.prepares).toBe(2);expect(f.counts.effects).toBe(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM session_call_outcomes WHERE turn_id=?").get(mapping.turnId)).toEqual({ n: 0 });
    expect(f.backend.destination.unsettled()).toEqual([]);
  } finally { await f.close(); }
}, 5000);

it("rechecks current authority after asynchronous automatic tool authorization before recording a successor or invoking an effect", async () => {
  const f = fixture("revocation");
  try {
    const id = await f.turns.ensure(f.declaration.bindingKey, scope);
    const operation = f.turns.turn(f.key, id, { text: "original" }, scope).then(() => null, error => error);
    await f.authorization;f.revoke();
    expect(await operation).toBeInstanceOf(SessionReconciliationRequired);
    const mapping = f.backend.destination.inspect(f.key)!;
    expect(f.db.prepare("SELECT count(*) AS n FROM session_run_segments WHERE turn_id=?").get(mapping.turnId)).toEqual({ n: 1 });
    expect(f.counts.prepares).toBe(1);expect(f.counts.effects).toBe(0);
    expect(f.backend.destination.unsettled()).toEqual([]);
  } finally { await f.close(); }
}, 5000);
