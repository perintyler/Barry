import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { getSessionsSqlite, closeSessionsDb } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { WorkflowDestinations } from "./workflow-destinations.js";
import { updateSessionSqlite, updateSessionMetadataSqlite, updateSessionMetadataNormalizedSqlite, endSessionSqlite, deleteSessionSqlite,
  archiveSessionSqlite, createProviderSessionSqlite, queuePromptSqlite, deleteSessionsByIdentitySqlite, issueWorkflowCredentialSqlite } from "./sessions-sqlite-writes.js";

let directory: string;
beforeEach(() => { closeSessionsDb(); directory = mkdtempSync(join(tmpdir(), "workflow-ownership-")); vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db")); });
afterEach(() => { closeSessionsDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const db = getSessionsSqlite(), bindingKey = "owner/run", identity = "selected-identity";
  const evidence = { identity, traits: ["retained"], bound: null, harness: "pi", tools: {} }, scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  const sessionId = workflowSessionId(bindingKey, identity);
  await workflowTurnsStore.admitBinding({ key: bindingKey, sessionId, identity, scopeHash: scope.fingerprint, requestHash: boundFingerprint({ key: bindingKey, identity, scope }), state: "admitted" });
  new WorkflowDestinations(db).bind({ bindingKey, sessionId, identity, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "fixture/model", endpoint: "fixture-endpoint", cwd: directory, maxTurns: 1, deadline: 2_000_000_000_000 } });
  return { db, sessionId };
}
it("rejects ordinary mutation and closure based on canonical membership even after its metadata marker is removed", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE sessions SET metadata='{}' WHERE id=?").run(f.sessionId);
  const before = f.db.prepare("SELECT * FROM sessions WHERE id=?").get(f.sessionId);
  for (const mutate of [
    () => updateSessionSqlite(f.sessionId, { bags: ["broader"] }),
    () => updateSessionMetadataSqlite(f.sessionId, { working_directory: "/another" }),
    () => updateSessionMetadataNormalizedSqlite(f.sessionId, { name: "relabelled" }),
    () => endSessionSqlite(f.sessionId, "interactive-stop"),
    () => archiveSessionSqlite(f.sessionId),
    () => deleteSessionSqlite(f.sessionId),
  ]) expect(mutate).toThrow("workflow executor");
  expect(f.db.prepare("SELECT * FROM sessions WHERE id=?").get(f.sessionId)).toEqual(before);
});
it("refuses ordinary provider registration and prompt queuing without durable side effects", async () => {
  const f = await fixture();
  expect(() => createProviderSessionSqlite({ session_id: f.sessionId, provider: "unexpected-provider", provider_session_id: "unexpected-handle" })).toThrow("workflow executor");
  expect(() => queuePromptSqlite(f.sessionId, "Alternate prompt", { clientMessageId: "interactive-request" })).toThrow("workflow executor");
  expect(f.db.prepare("SELECT count(*) AS n FROM provider_sessions WHERE session_id=?").get(f.sessionId)).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT 1 FROM agent_adapters WHERE id='unexpected-provider'").get()).toBeUndefined();
  expect(f.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=?").get(f.sessionId)).toEqual({ n: 0 });
});
it("keeps ordinary session updates, provider registration and closure available", async () => {
  const f = await fixture(); f.db.prepare("INSERT INTO sessions(id) VALUES('ordinary')").run();
  expect(updateSessionSqlite("ordinary", { bags: ["interactive"] })?.bags).toEqual(["interactive"]);
  updateSessionMetadataSqlite("ordinary", { name: "Interactive session" });
  expect(createProviderSessionSqlite({ session_id: "ordinary", provider: "pi", provider_session_id: "ordinary-provider" })).toMatchObject({ session_id: "ordinary", provider: "pi" });
  expect(endSessionSqlite("ordinary", "user-request")?.state).toBe("closed");
  expect(f.db.prepare("SELECT state FROM sessions WHERE id=?").get(f.sessionId)).toEqual({ state: "open" });
});
it("rejects bulk identity deletion atomically instead of deleting ordinary siblings before encountering workflow ownership", async () => {
  const f = await fixture();
  f.db.prepare("INSERT INTO sessions(id,identity_id) VALUES('ordinary-sibling',42)").run();
  expect(() => deleteSessionsByIdentitySqlite(42)).toThrow("workflow executor");
  expect(f.db.prepare("SELECT count(*) AS n FROM sessions WHERE identity_id=42").get()).toEqual({ n: 2 });
  f.db.prepare("INSERT INTO sessions(id,identity_id) VALUES('unrelated',43)").run();
  expect(deleteSessionsByIdentitySqlite(43)).toBe(1);
});
it("rejects generic credential issuance for canonical destinations while preserving existing scoped-session issuance", async () => {
  const f = await fixture();
  const expected = { actorId: 1, identityId: 42, boundFingerprint: f.db.prepare("SELECT scope_hash FROM session_workflow_bindings").pluck().get() as string };
  expect(() => issueWorkflowCredentialSqlite(f.sessionId, expected)).toThrow("workflow executor");
  expect(f.db.prepare("SELECT workflow_credential_id FROM sessions WHERE id=?").get(f.sessionId)).toEqual({ workflow_credential_id: null });
  f.db.prepare("INSERT INTO sessions(id,identity_id,user_id,metadata) SELECT 'existing-scoped-session',identity_id,user_id,metadata FROM sessions WHERE id=?").run(f.sessionId);
  expect(issueWorkflowCredentialSqlite("existing-scoped-session", expected)).toEqual(expect.any(String));
});
