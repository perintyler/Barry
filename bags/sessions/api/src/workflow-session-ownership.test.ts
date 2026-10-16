import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { withStoreContext, bootstrapStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { getSessionsSqlite, closeSessionsDb } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { WorkflowDestinations } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { SessionRuntime } from "./session-runtime.js";
import { prepareTurnSession, residentSession } from "./turn-execution.js";
import { assertInteractiveDestination } from "./workflow-session-ownership.js";

let directory: string;
beforeEach(() => {
  closeSessionsDb(); directory = mkdtempSync(join(tmpdir(), "workflow-runtime-ownership-"));
  vi.stubEnv("BARRY_HOME", join(directory, "home")); mkdirSync(join(directory, "home"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
});
afterEach(() => { closeSessionsDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
async function destination() {
  const db = getSessionsSqlite(), bindingKey = "owner/run", identity = "selected-identity";
  const evidence = { identity, traits: ["retained"], bound: null, harness: "pi", tools: {} }, scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  const sessionId = workflowSessionId(bindingKey, identity);
  await workflowTurnsStore.admitBinding({ key: bindingKey, sessionId, identity, scopeHash: scope.fingerprint, requestHash: boundFingerprint({ key: bindingKey, identity, scope }), state: "admitted" });
  new WorkflowDestinations(db).bind({ bindingKey, sessionId, identity, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "fixture/model", endpoint: "fixture-endpoint", cwd: directory, maxTurns: 1, deadline: 2_000_000_000_000 } });
  return { db, sessionId, identity };
}
it("refuses interactive start and legacy durable-turn preparation before credentials or resident capacity are acquired", async () => {
  const f = await destination(), runtime = new SessionRuntime();
  const acquire = vi.spyOn(runtime, "reserveResidentSession"), open = vi.spyOn(runtime, "ensureHarnessSession");
  await expect(runtime.startSession({ sessionId: f.sessionId, prompt: "Another prompt", repoPath: directory, prepareOnly: true })).rejects.toThrow("workflow executor");
  await expect(prepareTurnSession(f.sessionId)).rejects.toThrow("workflow executor");
  await expect(residentSession(f.sessionId)).rejects.toThrow("workflow executor");
  expect(acquire).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  expect(runtime.activeSessions.size).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM engines").get()).toEqual({ n: 0 });
});
it("refuses interactive message delivery, supplied workflow-turn IDs and renderer attachment before opening an agent", async () => {
  const f = await destination(), runtime = new SessionRuntime();
  const broadcast = vi.spyOn(runtime, "broadcastToSession"), open = vi.spyOn(runtime, "ensureHarnessSession");
  await expect(runtime.sendMessage(f.sessionId, "Interactive prompt")).rejects.toThrow("workflow executor");
  await expect(runtime.sendMessageAndWait(f.sessionId, "Spoofed workflow prompt", "caller-supplied-turn")).rejects.toThrow("workflow executor");
  await expect(runtime.attachRenderer(f.sessionId, process.pid)).rejects.toThrow("workflow executor");
  expect(open).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
  expect(f.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=?").get(f.sessionId)).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT count(*) AS n FROM provider_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ n: 0 });
});
it("discovers raw destination creation in its actual identity partition and applies the guard from an unscoped caller", async () => {
  vi.stubEnv("BARRY_SESSIONS_DB", ""); bootstrapStoreGeneration(barryStoresDir());
  const identity = "selected-identity";
  const f = await withStoreContext({ identity }, destination);
  expect(sessionIdentity(f.sessionId)).toBe(identity);
  expect(() => assertInteractiveDestination(f.sessionId)).toThrow("workflow executor");
  expect(withStoreContext({ identity }, () => new WorkflowDestinations(getSessionsSqlite()).lookupSession(f.sessionId))).toMatchObject({ identity, sessionId: f.sessionId });
});
