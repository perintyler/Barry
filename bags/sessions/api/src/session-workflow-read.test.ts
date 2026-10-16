import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { closeInstallationRegistry, installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { readSessionWorkflowWork, readSessionWorkflowWorkResult, stopSessionWorkflowWork, listSessionWorkflowSelections, sessionWorkflowCatalog, sessionWorkflowStopRefused } from "./session-workflow-read.js";

// Persisted ownership/current bounds are real. HTTP summaries are explicit
// transport fixtures, not accepted bounds or evidence of native execution.
const toolRegistry = vi.hoisted(() => ({ cancelOnly: false, getContract: "a".repeat(64) }));
const keyRead = vi.hoisted(() => ({ count: 0, afterRead: undefined as (() => void) | undefined }));
vi.mock("@barry-rocks/sdk/internal/services", async original => {
  const actual = await original<typeof import("@barry-rocks/sdk/internal/services")>();
  return { ...actual, installationSecrets: async (...args: Parameters<typeof actual.installationSecrets>) => {
    keyRead.count++;
    try { return await actual.installationSecrets(...args); }
    finally { keyRead.afterRead?.(); }
  } };
});
vi.mock("@barry-rocks/sdk/internal/tools", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/tools")>(),
  collectToolDefinitions: async () => [
    ...(!toolRegistry.cancelOnly ? [{ namespace: "workflows", toolName: "get", access: "read" as const, bag: "workflows", contractHash: toolRegistry.getContract }] : []),
    { namespace: "workflows", toolName: "cancel", access: "write" as const, bag: "workflows", contractHash: "b".repeat(64) },
  ],
}));

const principal = { kind: "installation" as const, actorId: 2, credentialId: "installation" as const };
const actorKey = "canonical-work-read-fixture-key-longer-than-thirty-two";
let directory: string, identity: string, installation: string;
let metadataHook: (() => void) | undefined, inspectHook: (() => void) | undefined;
let changedNamespace: Record<string, unknown>, mismatchedWork: boolean, payloadDenied: boolean, missingEndpoint: boolean, ackMismatch: string;
let stopError: { code: string; status: number } | undefined, loseStopReply: boolean;
const calls: { path: string; body: unknown }[] = [];
function item() {
  return { version: 2, work_id: mismatchedWork ? "work-other" : "work_11111111111111111111111111111111", workflow_id: "workflow-one", action_id: "arn-one", job_run_id: null,
    title: "Fixture canonical work", source: { kind: "action", reference: "fixture:script", catalog_namespace: "fixture" },
    origin: { entry_point: "sessions-work-api", trigger: "invocation", caller_session_id: "owned" },
    namespace: { installation, principal_kind: "identity", principal_id: identity, identity_id: identity, caller_session_id: "owned", ...changedNamespace },
    accepted_at: 1, first_started_at: 2, dispatch_deadline: 100, execution_deadline: 100, revision: 5, state: "running",
    facts: { coordinator: "running", phase: "executing", wait: "none", physical: "running", effect: "uncertain", stop_requested: false,
      has_result: false, can_continue: false, can_retry_step: false, can_respond: false },
    reason: null, receipt_ref: null, allowed_actions: ["inspect", "result", "stop"], can_review_reconciliation: false,
    projection: { desired_revision: 5, applied_revision: 0 },
  };
}
function closeSelected() { getSessionsSqlite().prepare("UPDATE sessions SET state='closed',ended_at='2026-10-15T00:00:00Z' WHERE id='owned'").run(); }
function revoke() { identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[]}' WHERE id=2").run(); }
const read = () => readSessionWorkflowWork("work_11111111111111111111111111111111", "owned", principal, identity);
const result = () => readSessionWorkflowWorkResult("work_11111111111111111111111111111111", "owned", principal, identity);
const stop = (body = { request_id: randomUUID(), expected_revision: 5, reason: "Stop selected identity work" }) => stopSessionWorkflowWork("work_11111111111111111111111111111111", body, "owned", principal, identity);

beforeEach(() => {
  closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  directory = mkdtempSync(join(tmpdir(), "sessions-canonical-work-"));
  vi.stubEnv("BARRY_HOME", directory); vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db")); vi.stubEnv("BARRY_SECRET", "canonical-read-fixture-hop");
  mkdirSync(join(directory, "config"), { recursive: true }); mkdirSync(join(directory, "app-support"), { recursive: true });
  writeFileSync(join(directory, "config/barry.yaml"), "secrets:\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  writeFileSync(join(directory, "app-support/env"), `BARRY_WORKFLOW_ACTOR_KEY=${actorKey}\n`, { mode: 0o600 });
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'foreign','user','Foreign'),(2,'owner','user','Owner')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(1,'foreign-id',1,'foreign','{\"bags\":[\"workflows\"]}'),(2,'owner-id',2,'owned','{\"bags\":[\"workflows\"]}')").run();
  owner.installation().bind({ actorId: 2, actorToken: "owner" }); Barry.use(identities, sessions);
  const insert = getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,'[\"workflows\"]','{}')");
  insert.run("owned", 2, 2); insert.run("foreign", 1, 1); insert.run("identity-free", 2, null);
  installation = installationRegistry().id; identity = installationRegistry().identityId(2);
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
    "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url: "http://127.0.0.1:12345" },
  } });
  calls.length = 0; metadataHook = undefined; inspectHook = undefined; changedNamespace = {}; mismatchedWork = false; payloadDenied = false; missingEndpoint = false; ackMismatch = ""; toolRegistry.cancelOnly = false; toolRegistry.getContract = "a".repeat(64); stopError = undefined; loseStopReply = false; keyRead.count = 0; keyRead.afterRead = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/api/metadata") { metadataHook?.(); return Response.json({ installation }); }
    const actor = new Headers(init?.headers).get("X-Workflow-Actor");
    expect(verifyWorkflowActor(actor!, actorKey, path, body)).toMatchObject({ principal: identity, operation: body ? "cancel" : "get" });
    if (missingEndpoint) return Response.json({ code: "NotFound", error: "fixture old owner" }, { status: 404 });
    if (path.endsWith("/stop")) {
      if (loseStopReply) throw new Error("Fixture loses reply after possible owner acceptance");
      if (stopError) return Response.json({ code: stopError.code, error: "Fixture owner refusal" }, { status: stopError.status });
      return Response.json({ version: 2, work_id: ackMismatch === "work" ? "other" : "work_11111111111111111111111111111111",
        request_id: ackMismatch === "request" ? randomUUID() : body.request_id, applied_revision: ackMismatch === "revision" ? 4 : 6, applied_at: 10, stop_requested: true });
    }
    if (path.endsWith("/result")) {
      if (payloadDenied) return Response.json({ code: "PayloadDenied", error: "Current caller cannot read work output." }, { status: 403 });
      return Response.json({ version: 2, work_id: mismatchedWork ? "other-result" : "work_11111111111111111111111111111111", revision: 6, status: "available", receipt_ref: null,
        closed_at: 10, outcome: { ok: true, value: { answer: "canonical result" } }, retained_output: null, logs: [] });
    }
    inspectHook?.(); return Response.json(item());
  }));
});
afterEach(() => {
  Barry.reset(); closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

it("reads canonical work and output without opening or inventing an Actions projection", async () => {
  const inspected = await read();
  expect(inspected).toMatchObject({ work_id: "work_11111111111111111111111111111111", action_id: "arn-one", namespace: { identity_id: identity }, allowed_actions: ["inspect", "result", "stop"] });
  expect(inspected).not.toHaveProperty("projection");
  expect(await result()).toMatchObject({ work_id: "work_11111111111111111111111111111111", outcome: { ok: true, value: { answer: "canonical result" } } });
  expect(calls.map(call => call.path)).toEqual(["/api/metadata", "/api/v2/work/work_11111111111111111111111111111111", "/api/metadata", "/api/v2/work/work_11111111111111111111111111111111", "/api/v2/work/work_11111111111111111111111111111111/result"]);
});
it("lists only actual owned identity sessions with no foreign, identity-free or transcript metadata", async () => {
  expect(await listSessionWorkflowSelections(principal)).toEqual({ sessions: [{ id: "owned", name: null, identity_id: 2, ended: false }] });
  getSessionsSqlite().prepare("UPDATE sessions SET metadata=? WHERE id='owned'").run(JSON.stringify({ name: "Owned picker label", private: "not-a-picker-field" }));
  expect(await listSessionWorkflowSelections(principal)).toEqual({ sessions: [{ id: "owned", name: "Owned picker label", identity_id: 2, ended: false }] });
  closeSelected(); expect(await listSessionWorkflowSelections(principal)).toMatchObject({ sessions: [{ id: "owned", ended: true }] });
  expect(calls).toEqual([]);
});
it("refuses an unavailable picker owner or invalid selected action list without discovery or owner HTTP fallback", async () => {
  await expect(listSessionWorkflowSelections(undefined)).rejects.toMatchObject({ status: 403 });
  await expect(sessionWorkflowCatalog("foreign", principal, identity)).rejects.toMatchObject({ status: 403 });
  await expect(sessionWorkflowCatalog("unknown", principal, identity)).rejects.toMatchObject({ status: 403 });
  revoke(); await expect(sessionWorkflowCatalog("owned", principal, identity)).rejects.toMatchObject({ status: 403 });
  expect(calls).toEqual([]);
});
it.each(["..", ".", "../work", "work_"])("refuses work path segment %s without owner calls", async invalid => {
  await expect(readSessionWorkflowWork(invalid, "owned", principal, identity)).rejects.toThrow(); expect(calls).toEqual([]);
});
it("allows ended get-only recovery without advertising or allowing Stop", async () => {
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[\"workflows:read\"]}' WHERE id=2").run(); closeSelected();
  expect((await read()).allowed_actions).toEqual(["inspect", "result"]);
  await expect(result()).resolves.toMatchObject({ status: "available" });
  calls.length = 0; await expect(stop()).rejects.toMatchObject({ code: "WorkReadDenied", status: 403 }); expect(calls).toEqual([]);
});
it("permits cancel-only Stop without an inspect/get authority requirement and preserves exact replay", async () => {
  toolRegistry.cancelOnly = true;
  const intent = { request_id: randomUUID(), expected_revision: 5, reason: "Original reason" };
  const first = await stop(intent); expect(await stop(intent)).toEqual(first);
  expect(calls.filter(call => call.body !== undefined)).toEqual([{ path: "/api/v2/work/work_11111111111111111111111111111111/stop", body: intent }, { path: "/api/v2/work/work_11111111111111111111111111111111/stop", body: intent }]);
  expect(calls.some(call => call.path === "/api/v2/work/work_11111111111111111111111111111111")).toBe(false);
});
it.each(["unknown", "foreign", "identity-free"])("refuses %s session selection before contacting the workflow owner", async sessionId => {
  await expect(readSessionWorkflowWork("work_11111111111111111111111111111111", sessionId, principal, identity)).rejects.toMatchObject({ status: 403 }); expect(calls).toEqual([]);
});
it("refuses a device or unselected caller instead of borrowing installation/operator scope", async () => {
  await expect(readSessionWorkflowWork("work_11111111111111111111111111111111", "owned", undefined, identity)).rejects.toMatchObject({ status: 403 });
  await expect(readSessionWorkflowWork("work_11111111111111111111111111111111", "owned", principal, undefined)).rejects.toMatchObject({ status: 403 });
  await expect(readSessionWorkflowWork("work_11111111111111111111111111111111", "owned", { ...principal, kind: "device" } as never, identity)).rejects.toMatchObject({ status: 403 });
  expect(calls).toEqual([]);
});
it.each(["installation", "principal_kind", "principal_id", "identity_id"])("rejects a canonical response bound to another %s", async field => {
  changedNamespace = { [field]: field === "principal_kind" ? "operator" : "foreign" };
  await expect(result()).rejects.toMatchObject({ code: "WorkReadUnknown" });
  expect(calls.some(call => call.path.endsWith("/result"))).toBe(false);
});
it("rechecks policy after asynchronous metadata and refuses revoked reads before forwarding", async () => {
  metadataHook = revoke; await expect(read()).rejects.toMatchObject({ status: 403 });
  expect(calls.map(call => call.path)).toEqual(["/api/metadata"]);
});
it("refuses a missing declared actor key without sending an unsigned identity read", async () => {
  writeFileSync(join(directory, "app-support/env"), "");
  const error = await read().catch(error => error);
  expect(error).toMatchObject({ code: "WorkActorUnavailable", status: 503, retryable: true });
  expect(error.message).toBe("Selected identity workflow access requires a readable declared actor signing key.");
  expect(calls).toEqual([]);
});
it("does not borrow ambient actor credentials when the signing key is undeclared or too short", async () => {
  vi.stubEnv("BARRY_WORKFLOW_ACTOR_KEY", actorKey);
  writeFileSync(join(directory, "config/barry.yaml"), "secrets: {}\n");
  await expect(read()).rejects.toMatchObject({ code: "WorkActorUnavailable", status: 503 });
  writeFileSync(join(directory, "config/barry.yaml"), "secrets:\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  writeFileSync(join(directory, "app-support/env"), "BARRY_WORKFLOW_ACTOR_KEY=short-private-canary\n");
  const error = await read().catch(error => error);
  expect(error).toMatchObject({ code: "WorkActorUnavailable", status: 503 }); expect(error.message).not.toContain("short-private-canary");
  expect(calls).toEqual([]);
});
it("denies an unauthorized selection before reading the installation key, even when configuration is broken", async () => {
  writeFileSync(join(directory, "app-support/env"), "");
  await expect(readSessionWorkflowWork("work_11111111111111111111111111111111", "foreign", principal, identity)).rejects.toMatchObject({ code: "WorkReadDenied", status: 403 });
  expect(keyRead.count).toBe(0); expect(calls).toEqual([]);
});
it("checks an owned caller's current get grant before reading the credential provider", async () => {
  revoke();
  await expect(read()).rejects.toMatchObject({ code: "WorkReadDenied", status: 403 });
  expect(keyRead.count).toBe(0); expect(calls).toEqual([]);
});
it("rechecks caller authority after a failed key read before reporting configuration availability", async () => {
  writeFileSync(join(directory, "app-support/env"), ""); keyRead.afterRead = revoke;
  await expect(read()).rejects.toMatchObject({ code: "WorkReadDenied", status: 403 });
  expect(keyRead.count).toBe(1); expect(calls).toEqual([]);
});
it("rechecks open-session ownership after metadata before a Stop effect", async () => {
  metadataHook = closeSelected; await expect(stop()).rejects.toMatchObject({ status: 403 });
  expect(calls.map(call => call.path)).toEqual(["/api/metadata"]);
});
it("does not disclose a read or request payload after current authority is revoked during inspection", async () => {
  inspectHook = revoke; await expect(result()).rejects.toMatchObject({ status: 403 });
  expect(calls.some(call => call.path.endsWith("/result"))).toBe(false);
});
it("rejects an in-flight read after the get contract changes even while get remains granted", async () => {
  inspectHook = () => { toolRegistry.getContract = "c".repeat(64); };
  await expect(read()).rejects.toMatchObject({ status: 403 });
  // Current get remains authorized: a fresh, consistently bound read works.
  inspectHook = undefined; await expect(read()).resolves.toMatchObject({ work_id: "work_11111111111111111111111111111111" });
});
it("preserves the canonical payload denial instead of returning metadata as a successful result", async () => {
  payloadDenied = true; await expect(result()).rejects.toMatchObject({ code: "PayloadDenied", status: 403 });
});
it("rejects a mismatched requested work ID before fetching output", async () => {
  mismatchedWork = true; await expect(result()).rejects.toMatchObject({ code: "WorkReadUnknown" });
  expect(calls.some(call => call.path.endsWith("/result"))).toBe(false);
});
it.each(["work", "request", "revision"])("retains Stop uncertainty after mismatched acknowledgement %s", async mismatch => {
  ackMismatch = mismatch; await expect(stop()).rejects.toMatchObject({ code: "WorkStopUnknown", retryable: true });
  expect(calls.filter(call => call.body !== undefined)).toHaveLength(1);
});
it("preserves an older-owner refusal without trying legacy cancellation or another endpoint", async () => {
  missingEndpoint = true; await expect(stop()).rejects.toMatchObject({ status: 404 });
  expect(calls.map(call => call.path)).toEqual(["/api/metadata", "/api/v2/work/work_11111111111111111111111111111111/stop"]);
});
it("marks a local pre-forward Stop denial as refused", async () => {
  closeSelected(); const error = await stop().catch(error => error);
  expect(sessionWorkflowStopRefused(error)).toBe(true); expect(calls).toEqual([]);
});
it.each([
  { code: "WorkRevisionConflict", status: 409 }, { code: "WorkStopUnavailable", status: 409 },
  { code: "WorkNotFound", status: 404 }, { code: "Forbidden", status: 403 },
])("marks canonical pre-mutation Stop refusal $code/$status", async refusal => {
  stopError = refusal; const error = await stop().catch(error => error);
  expect(sessionWorkflowStopRefused(error)).toBe(true); expect(calls.filter(call => call.body !== undefined)).toHaveLength(1);
});
it.each([{ code: "ArbitraryConflict", status: 409 }, { code: "Forbidden", status: 409 }, { code: "WorkRevisionConflict", status: 503 }])("does not infer Stop refusal from arbitrary $code/$status", async refusal => {
  stopError = refusal; const error = await stop().catch(error => error);
  expect(sessionWorkflowStopRefused(error)).toBe(false);
});
it("retains uncertainty after forwarded transport loss or malformed acknowledgement", async () => {
  loseStopReply = true; const lost = await stop().catch(error => error);
  expect(sessionWorkflowStopRefused(lost)).toBe(false);
  loseStopReply = false; ackMismatch = "work"; const malformed = await stop().catch(error => error);
  expect(sessionWorkflowStopRefused(malformed)).toBe(false);
  expect(calls.filter(call => call.body !== undefined)).toHaveLength(2);
});
