import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { closeInstallationRegistry, installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { bagDataDir, writeServiceRegistry } from "@barry-rocks/sdk/services";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import type { WorkSubmission } from "@barry-rocks/sdk/internal/workflows";

// Ownership, selected bounds, bound intersection and durable issuer records are
// real. The controlled tool list and failed HTTP transport are fixture seams;
// these tests neither fabricate an accepted bound nor claim owner admission.
const toolRegistry = vi.hoisted(() => ({ duringRead: undefined as (() => void) | undefined }));
vi.mock("@barry-rocks/sdk/internal/tools", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/tools")>(),
  collectToolDefinitions: async () => {
    const hook = toolRegistry.duringRead; toolRegistry.duringRead = undefined; hook?.();
    return [
      { namespace: "workflows", toolName: "start", access: "write", bag: "workflows", contractHash: "a".repeat(64) },
      { namespace: "workflows", toolName: "get", access: "read", bag: "workflows", contractHash: "c".repeat(64) },
      { namespace: "bash", toolName: "Bash", access: "write", bag: "bash", contractHash: "b".repeat(64) },
    ];
  },
}));

import { startSessionWorkflowAction, lookupSessionWorkflowAction, sessionWorkAdmissionRefused } from "./session-workflow-admission.js";
import { sessionWorkflowScope } from "./session-workflow-control.js";

const principal = { kind: "installation" as const, actorId: 2, credentialId: "installation" as const };
const issuerName = "workflows.sessions.identity";
const actorKey = "session-admission-read-fixture-key-longer-than32";
let directory: string, identity: string, installation: string, keysPath: string;
let metadataHook: (() => void | Promise<void>) | undefined;
let submissionStatus: number | undefined;
let submissionDisposition: string | undefined;
let submissionCode: string;
const posts: { request: WorkSubmission; delegation: { assertion: string; record: Record<string, unknown> } }[] = [];
const calls: string[] = [];
const reads: { path: string; actor: string | null }[] = [];
const input = () => ({ request_id: randomUUID(), idempotency_key: "identity-script", inputs: { value: "original" } });
function writeKeys(id = "first") {
  writeFileSync(keysPath, JSON.stringify({ [issuerName]: [{ id, secret: `session-admission-${id}-dedicated-key-longer-than-32-bytes`,
    not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
}
function records() {
  const db = new Database(join(bagDataDir("sessions"), "work-admission-issuer.db"), { readonly: true });
  try { return db.prepare("SELECT grant_ref,record FROM delegation_records ORDER BY grant_ref").all() as { grant_ref: string; record: string }[]; }
  finally { db.close(); }
}
async function submit(body: unknown = input(), sessionId = "owned", asked = principal, selectedIdentity: string | undefined = identity) {
  return startSessionWorkflowAction("fixture:script", body, sessionId, asked, selectedIdentity);
}
beforeEach(() => {
  closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  directory = mkdtempSync(join(tmpdir(), "sessions-work-admission-"));
  vi.stubEnv("BARRY_HOME", directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  vi.stubEnv("BARRY_SECRET", "session-admission-fixture-hop");
  keysPath = join(directory, "delegation-keys.json");
  vi.stubEnv("BARRY_WORKFLOW_DELEGATION_KEYS", keysPath); writeKeys();
  mkdirSync(join(directory, "config"), { recursive: true });
  mkdirSync(join(directory, "app-support"), { recursive: true });
  writeFileSync(join(directory, "config", "barry.yaml"), "secrets:\n  BARRY_SECRET: {in: .env}\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  writeFileSync(join(directory, "app-support", "env"), `BARRY_SECRET=session-admission-fixture-hop\nBARRY_WORKFLOW_ACTOR_KEY=${actorKey}\n`, { mode: 0o600 });
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'foreign','user','Foreign'),(2,'owner','user','Owner')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(1,'foreign-id',1,'foreign','{\"bags\":[\"workflows\",\"bash\"]}'),(2,'owner-id',2,'owned','{\"bags\":[\"workflows\",\"bash\"]}')").run();
  owner.installation().bind({ actorId: 2, actorToken: "owner" }); Barry.use(identities, sessions);
  const insert = getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,'[\"workflows\",\"bash\"]','{}')");
  insert.run("owned", 2, 2); insert.run("foreign", 1, 1); insert.run("identity-free", 2, null);
  installation = installationRegistry().id; identity = installationRegistry().identityId(2);
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
    "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url: "http://127.0.0.1:12345" },
  } });
  posts.length = 0; calls.length = 0; reads.length = 0; metadataHook = undefined; submissionStatus = undefined; submissionDisposition = undefined; submissionCode = "FixtureUnavailable"; toolRegistry.duringRead = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === "/api/metadata") {
      await metadataHook?.();
      return Response.json({ installation });
    }
    if (path === "/api/v2/work/submissions") {
      posts.push(JSON.parse(String(init?.body)));
      if (submissionStatus !== undefined) return Response.json({ code: submissionCode, error: "No compatible owner endpoint", ...(submissionDisposition ? { admission_disposition: submissionDisposition } : {}) }, { status: submissionStatus });
      throw new Error("Fixture loses the submission reply; acceptance is deliberately unproven");
    }
    if (path === "/api/v2/work/operations") {
      reads.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, actor: new Headers(init?.headers).get("X-Workflow-Actor") });
      // A mocked read acknowledgement is deliberately not admission evidence.
      return Response.json({ version: 2, work_id: "work-existing", workflow_id: "workflow-existing", action_id: "arn-existing",
        namespace: { installation, principal_kind: "identity", principal_id: identity, identity_id: identity, caller_session_id: "owned" } });
    }
    throw new Error(`Unexpected fixture HTTP path: ${path}`);
  }));
});
afterEach(() => {
  Barry.reset(); closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("persists one original identity/session intent across lost replies, key renewal and fresh helper calls", async () => {
  const request = input();
  await expect(submit(request)).rejects.toThrow();
  expect(posts).toHaveLength(1);
  const original = records(); expect(original).toHaveLength(1);
  expect(posts[0].request).toMatchObject({ idempotency_key: request.idempotency_key, inputs: request.inputs,
    definition: { kind: "action", reference: "fixture:script", catalog_namespace: "fixture" }, origin: { caller_session_id: "owned" } });
  expect(posts[0].delegation.record).toMatchObject({ issuer: issuerName, source_kind: "session", background_parent: false,
    authority: { namespace: { installation, principal_kind: "identity", principal_id: identity, identity_id: identity, caller_session_id: "owned" },
      caller_ceiling: { identity, tools: { "workflows:start": "write", "bash:Bash": "write" }, contracts: { "bash:Bash": "b".repeat(64) } } } });
  writeKeys("rotated");
  await expect(submit({ ...request, request_id: randomUUID() })).rejects.toThrow();
  expect(records()).toEqual(original); expect(posts).toHaveLength(2);
  expect(posts[1].request.authority_ref).toBe(posts[0].request.authority_ref);
  expect(posts[1].delegation.record).toEqual(posts[0].delegation.record);
  expect(posts[1].delegation.assertion).not.toBe(posts[0].delegation.assertion);
  await expect(submit({ ...request, inputs: { value: "changed" } })).rejects.toThrow();
  expect(posts).toHaveLength(2); expect(records()).toEqual(original);
});

it.each(["foreign", "missing", "identity-free", "closed", "wrong-partition"])("refuses %s session authority before forwarding", async selected => {
  if (selected === "closed") getSessionsSqlite().prepare("UPDATE sessions SET state='closed',ended_at='2026-10-15T00:00:00Z' WHERE id='owned'").run();
  await expect(submit(input(), ["closed", "wrong-partition"].includes(selected) ? "owned" : selected,
    principal, selected === "wrong-partition" ? "another-identity" : identity)).rejects.toThrow();
  expect(posts).toEqual([]);
});
it("refuses device or absent authentication without forwarding", async () => {
  const device = { kind: "device" as const, credentialId: "paired", actorId: 2, identityIds: [2], scopes: [] };
  for (const caller of [undefined, device]) {
    await expect(startSessionWorkflowAction("fixture:script", input(), "owned", caller, identity)).rejects.toThrow();
  }
  expect(posts).toEqual([]);
});
it("refuses a missing active dedicated issuer key without borrowing the actor or hop credential", async () => {
  writeFileSync(keysPath, JSON.stringify({}));
  vi.stubEnv("BARRY_WORKFLOW_ACTOR_KEY", "ambient-actor-key-must-not-delegate-this-session");
  await expect(submit()).rejects.toThrow(); expect(posts).toEqual([]);
});
it.each(["workflows", "bash"])("requires both launch permissions when only %s is currently granted", async namespace => {
  identitiesSqlite().prepare("UPDATE identities SET metadata=? WHERE id=2").run(JSON.stringify({ bags: [namespace] }));
  await expect(submit()).rejects.toThrow(); expect(posts).toEqual([]);
});
it("refuses a configured owner whose installation differs from the selected local authority", async () => {
  metadataHook = () => { installation = "wrong-owner"; };
  await expect(submit()).rejects.toThrow(); expect(posts).toEqual([]);
});
it.each(["workflow_bound", "action-executor"])("refuses nested detached admission from %s", async kind => {
  const metadata = kind === "workflow_bound"
    ? { workflow_bound: (await sessionWorkflowScope("owned", principal, identity)).scope, workflow_identity_id: 2 }
    : { source: "action-executor" };
  getSessionsSqlite().prepare("UPDATE sessions SET metadata=? WHERE id='owned'").run(JSON.stringify(metadata));
  await expect(submit()).rejects.toThrow(); expect(posts).toEqual([]);
});
it("rejects a detached-parent source change during the shared scope's asynchronous tool read", async () => {
  toolRegistry.duringRead = () => {
    getSessionsSqlite().prepare("UPDATE sessions SET metadata=? WHERE id='owned'").run(JSON.stringify({ source: "action-executor" }));
  };
  await expect(sessionWorkflowScope("owned", principal, identity)).rejects.toThrow();
  expect(posts).toEqual([]);
});
it("rechecks current selected bound after a delayed metadata read and never forwards a revoked launch", async () => {
  const request = input();
  metadataHook = () => { identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[]}' WHERE id=2").run(); };
  await expect(submit(request)).rejects.toThrow(); expect(calls).toContain("/api/metadata"); expect(posts).toEqual([]);
  const prepared = records(); expect(prepared).toHaveLength(1);
  metadataHook = undefined;
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[\"workflows\",\"bash\"]}' WHERE id=2").run();
  await expect(submit(request)).rejects.toThrow();
  expect(posts).toHaveLength(1); expect(records()).toEqual(prepared);
});
it("does not fall back to legacy action execution when the owner lacks delegated admission", async () => {
  submissionStatus = 404;
  await expect(submit()).rejects.toThrow();
  expect(posts).toHaveLength(1);
  expect(calls.every(path => path === "/api/metadata" || path === "/api/v2/work/submissions")).toBe(true);
});
it("rejects malformed stable input before submitting any work", async () => {
  for (const body of [{ ...input(), request_id: "not-a-uuid" }, { ...input(), idempotency_key: "x".repeat(201) }, { ...input(), inputs: [] }, { ...input(), inputs: {}, unexpected: true }]) {
    await expect(submit(body)).rejects.toThrow();
  }
  expect(posts).toEqual([]);
});

it("marks only a proven unforwarded attempt as refused", async () => {
  const malformed = await submit({ ...input(), request_id: "invalid" }).catch(error => error);
  expect(sessionWorkAdmissionRefused(malformed)).toBe(true); expect(posts).toEqual([]);
  metadataHook = () => { identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[]}' WHERE id=2").run(); };
  const revoked = await submit().catch(error => error);
  expect(sessionWorkAdmissionRefused(revoked)).toBe(true); expect(posts).toEqual([]);
});
it("never labels a lost forwarded reply or ordinary upstream refusal as proven non-acceptance", async () => {
  const lost = await submit().catch(error => error);
  expect(sessionWorkAdmissionRefused(lost)).toBe(false); expect(posts).toHaveLength(1);
  submissionStatus = 404;
  const oldOwner = await submit().catch(error => error);
  expect(sessionWorkAdmissionRefused(oldOwner)).toBe(false); expect(posts).toHaveLength(2);
});
it("preserves trusted owner non-acceptance evidence without inferring it from status", async () => {
  submissionStatus = 400; submissionDisposition = "not-accepted";
  const refused = await submit().catch(error => error);
  expect(sessionWorkAdmissionRefused(refused)).toBe(true); expect(posts).toHaveLength(1);
  submissionDisposition = "unrecognized";
  const unknown = await submit().catch(error => error);
  expect(sessionWorkAdmissionRefused(unknown)).toBe(false);
});
it("propagates selected-credential pre-admission refusal only from explicit owner evidence", async () => {
  submissionStatus = 409; submissionCode = "WorkCredentialsUnavailable"; submissionDisposition = "not-accepted";
  const refused = await submit().catch(error => error);
  expect(refused).toMatchObject({ code: "WorkCredentialsUnavailable", status: 409 });
  expect(sessionWorkAdmissionRefused(refused)).toBe(true); expect(posts).toHaveLength(1);
  submissionDisposition = undefined;
  const unmarked = await submit().catch(error => error);
  expect(unmarked).toMatchObject({ code: "WorkCredentialsUnavailable", status: 409 });
  expect(sessionWorkAdmissionRefused(unmarked)).toBe(false);
  submissionCode = "ArbitraryConflict";
  expect(sessionWorkAdmissionRefused(await submit().catch(error => error))).toBe(false);
});

it("reads an existing operation after launch permission and the dedicated issuer key are removed without minting authority", async () => {
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[\"workflows:read\"]}' WHERE id=2").run();
  getSessionsSqlite().prepare("UPDATE sessions SET state='closed',ended_at='2026-10-15T00:00:00Z' WHERE id='owned'").run();
  writeFileSync(keysPath, JSON.stringify({}));
  const key = "existing key with spaces";
  await expect(lookupSessionWorkflowAction(key, "owned", principal, identity)).resolves.toEqual({
    run_id: "arn-existing", work_id: "work-existing", workflow_id: "workflow-existing", idempotency_key: key, created: false,
  });
  expect(reads).toHaveLength(1);
  expect(new URL(reads[0].path, "http://fixture").searchParams.get("key")).toBe(key);
  expect(new URL(reads[0].path, "http://fixture").searchParams.get("session")).toBe("owned");
  expect(verifyWorkflowActor(reads[0].actor!, actorKey, reads[0].path)).toMatchObject({ principal: identity, operation: "get" });
  expect(posts).toEqual([]);
  expect(existsSync(join(bagDataDir("sessions"), "work-admission-issuer.db"))).toBe(false);
});
