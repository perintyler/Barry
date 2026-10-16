import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { installationRegistry, closeInstallationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { sessionWorkflowActor } from "./session-workflow-control.js";

// Controlled installed tool list; ownership authorization, records, bounds, registry and key binding are real.
vi.mock("@barry-rocks/sdk/internal/tools", async original => ({ ...await original<typeof import("@barry-rocks/sdk/internal/tools")>(),
  collectToolDefinitions: async () => [{ namespace: "workflows", toolName: "cancel", access: "write", bag: "workflows" }],
}));
let directory: string, identity: string;
const principal = { kind: "installation" as const, actorId: 2, credentialId: "installation" as const };
const key = "persisted-session-bound-owned-signing-key-longer-than32", path = "/api/v2/work/owned-work/stop";
const body = { version: 2, request_id: "persistent-bound", expected_revision: 1 };
beforeEach(() => {
  closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  directory = mkdtempSync(join(tmpdir(), "sessions-work-bound-"));
  vi.stubEnv("BARRY_HOME", directory); vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db")); vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  mkdirSync(join(directory, "config"), { recursive: true }); mkdirSync(join(directory, "app-support"), { recursive: true });
  writeFileSync(join(directory, "config", "barry.yaml"), "secrets:\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  writeFileSync(join(directory, "app-support", "env"), `BARRY_WORKFLOW_ACTOR_KEY=${key}\n`, { mode: 0o600 });
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'foreign','user','Foreign'),(2,'owner','user','Owner')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(1,'foreign-id',1,'foreign','{\"bags\":[\"workflows\"]}'),(2,'owner-id',2,'owned','{\"bags\":[\"workflows\"]}')").run();
  owner.installation().bind({ actorId: 2, actorToken: "owner" }); Barry.use(identities, sessions);
  const insert = getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,'[\"workflows\"]','{}')");
  insert.run("owned", 2, 2); insert.run("foreign", 1, 1); insert.run("wrong-identity", 2, 1);
  identity = installationRegistry().identityId(2);
});
afterEach(() => {
  Barry.reset(); closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
it("uses the actual persisted session, current bound, canonical identity and declared installation key", async () => {
  const token = await sessionWorkflowActor("owned", principal, identity)(path, body);
  expect(verifyWorkflowActor(token, key, path, body)).toMatchObject({ principal: identity, operation: "cancel" });
});
it("refuses actual foreign, unknown and identity-mismatched session ownership", async () => {
  for (const id of ["foreign", "wrong-identity", "missing"]) await expect(sessionWorkflowActor(id, principal, identity)(path, body)).rejects.toThrow();
  await expect(sessionWorkflowActor("owned", { ...principal, actorId: 1 }, identity)(path, body)).rejects.toThrow("owner is unavailable");
});
it("observes a real stored bag revocation and session ending through the same callback", async () => {
  const sign = sessionWorkflowActor("owned", principal, identity);
  await sign(path, body);
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[]}' WHERE id=2").run();
  await expect(sign(path, body)).rejects.toThrow("tool access denied");
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[\"workflows\"]}' WHERE id=2").run();
  await sign(path, body);
  getSessionsSqlite().prepare("UPDATE sessions SET state='closed',ended_at='2026-10-15T00:00:00Z' WHERE id='owned'").run();
  await expect(sign(path, body)).rejects.toThrow("selected session");
});
