import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Barry } from "@barry-rocks/sdk";
import { BarryClient } from "@barry-rocks/sdk/internal/client";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { withStoreContext, bootstrapStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { installationRegistry, closeInstallationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { forgetSessionIdentity, sessionIdentity } from "@barry-rocks/sdk/stores";
import { identities, access, owner as installationOwner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { sessions } from "@barry-rocks/sessions-bag";
import { getSessionsSqlite, closeSessionsDb } from "@barry-rocks/sessions-bag/store/sessions-db";
import { createActionWorkProjection, closeDb } from "@barry-rocks/actions-bag";
import { getDb as actionsDb } from "@barry-rocks/actions-bag/db";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { WorkflowOwner, WorkArtifactStore, ProcessExecutor, WorkAdmissionService, WorkControlService, inspectArtifact, WorkflowError, type WorkResolution } from "@barry-rocks/sdk/internal/workflows";
import { createWorkflowServer } from "@barry-rocks/workflows-bag";
import { sessionsApi } from "./app.js";
import { runningAgents } from "./routes/actions-executor-support.js";
import { createNativeControlWork } from "./testing/workflow-control-native.js";

const addresses = vi.hoisted(() => ({ owner: "" }));
vi.mock("@barry-rocks/sdk/services", async original => ({ ...await original<typeof import("@barry-rocks/sdk/services")>(),
  serviceAddress: (name: string) => { if (name === "workflows.runtime") return addresses.owner; throw new Error("unconfigured fixture service"); },
}));
// The installed tool list is controlled; credential verification, partition routing,
// ownership, current bounds, declared secrets and both HTTP handlers are production code.
vi.mock("@barry-rocks/sdk/internal/tools", async original => ({ ...await original<typeof import("@barry-rocks/sdk/internal/tools")>(),
  collectToolDefinitions: async () => [{ namespace: "workflows", toolName: "cancel", access: "write", bag: "workflows" }],
}));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function timerWork(root: string, identity: string, installation: string) {
  const file = join(root, "workflow.mjs"); writeFileSync(file, "export const definitions=[{type:'combined-control',version:'1',*run(input){yield {kind:'timer',delayMs:60000};return input;}}];");
  const artifact = inspectArtifact(file, "combined-control", "1"), artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const source = artifacts.stage(readFileSync(file), { purpose: "source", media_type: "text/javascript", owner_identity: identity });
  const scope = await approveWorkflowBounds({ identity, bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const namespace = { installation, principal_kind: "identity" as const, principal_id: identity, identity_id: identity, caller_session_id: "owned" };
  const origin = { entry_point: "fixture", trigger: "manual" as const, caller_session_id: "owned" }, authority = { namespace, origin, run_identity: identity, caller_ceiling: scope };
  const grant = { version: 2 as const, grant_ref: "fixture", revision: 1, namespace, authorizer: identity, created_by: identity, approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const owner = new WorkflowOwner({ id: installation, path: join(root, "owner.db"), artifacts: [artifact], executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope });
  const close = async () => { await owner.drain(); owner.close(); artifacts.close(); }; cleanup.push(close);
  const admission = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async (input): Promise<WorkResolution> => ({ title: "Combined control fixture", grant, workflow_input: input.inputs, plan: {
    version: 2, definition: input.definition, workflow: { type: artifact.type, version: artifact.version, artifact_digest: artifact.digest, runtime_abi: artifact.abi, input_digest: boundFingerprint(input.inputs) }, source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable", effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 10000 }, validation: { mode: "none" },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: installation, host_reservation: null, endpoint: null }, workspace: { kind: "none" }, selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 10000, dispatch_budget_ms: 60000,
  } }) });
  const work = await admission.submit({ version: 2, request_id: randomUUID(), idempotency_key: "fixture", authority_ref: "fixture", origin, definition: { kind: "action", reference: "fixture:combined-control", catalog_namespace: "fixture" }, inputs: {} }, null);
  await owner.pump();
  return { owner, work, namespace, workflowType: artifact.type };
}
const secret = "combined-session-http-installation-secret", firstKey = "combined-session-declared-actor-key-longer-than-32-bytes";
async function fixture(native = false) {
  const root = mkdtempSync(join(tmpdir(), "combined-session-control-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  closeDb(); closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry();
  vi.stubEnv("BARRY_HOME", root); vi.stubEnv("BARRY_SECRET", secret);
  for (const name of ["BARRY_SESSIONS_DB", "BARRY_ACTIONS_DB", "BARRY_IDENTITIES_DB"]) vi.stubEnv(name, undefined);
  cleanup.push(() => { runningAgents.clear(); closeDb(); closeSessionsDb(); closeIdentitiesStore(); closeInstallationRegistry(); Barry.reset(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  mkdirSync(join(root, "config"), { recursive: true }); mkdirSync(join(root, "app-support"), { recursive: true });
  writeFileSync(join(root, "config", "barry.yaml"), "secrets:\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  const rotateKey = (key: string) => writeFileSync(join(root, "app-support", "env"), `BARRY_WORKFLOW_ACTOR_KEY=${key}\n`, { mode: 0o600 }); rotateKey(firstKey);
  bootstrapStoreGeneration(barryStoresDir());
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'foreign','user','Foreign'),(2,'owner','user','Owner')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(1,'foreign-id',1,'foreign','{\"bags\":[\"workflows\"]}'),(2,'owner-id',2,'owned','{\"bags\":[\"workflows\"]}')").run();
  installationOwner.installation().bind({ actorId: 2, actorToken: "owner" }); Barry.use(identities, sessions);
  const registry = installationRegistry(), identity = registry.identityId(2), foreignIdentity = registry.identityId(1);
  const seedSession = (partition: string, id: string, actor: number, identityId: number) => withStoreContext({ identity: partition }, () => {
    forgetSessionIdentity(id);
    getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,'[\"workflows\"]','{}')").run(id, actor, identityId);
  });
  seedSession(identity, "owned", 2, 2); seedSession(foreignIdentity, "foreign", 1, 1);
  expect(sessionIdentity("owned")).toBe(identity);
  const nativeWork = native ? await createNativeControlWork(root, identity, registry.id) : null;
  if (nativeWork) cleanup.push(nativeWork.close);
  const setup = nativeWork ?? await timerWork(root, identity, registry.id), { owner, work, namespace } = setup;
  const projection = withStoreContext({ identity }, () => createActionWorkProjection({ database: actionsDb(), namespace,
    result: value => owner.workResult({ kind: "namespace", namespace }, value.work_id) }));
  await owner.publishWorkProjections(projection);
  const state = { revoked: false, dropReply: false, authorized: [] as (string | null)[], actorTokens: [] as string[] };
  const controls = new WorkControlService<string | null>({ owner, authorize: async principal => {
    state.authorized.push(principal);
    if (principal === null) throw new WorkflowError("RootFallbackForbidden", "Identity fixture requires signed authority.", 403);
    return { actor: principal, scope: { kind: "identity", installation: registry.id, identity_id: principal }, controls: ["stop"] };
  } });
  const upstream = await listen(createWorkflowServer({ owner, secret, authenticateWorker: () => null,
    readActorKey: async () => (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY,
    grants: () => state.revoked ? {} : { [identity]: { types: [setup.workflowType], operations: ["get", "cancel"], payloadRead: false } }, workControls: controls,
  }));
  // Relay only injects transport loss after the real owner has replied; it never fabricates acknowledgements.
  addresses.owner = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(Buffer.from(bytes));
    if (req.method === "POST" && req.url?.endsWith("/stop") && typeof req.headers["x-workflow-actor"] === "string") state.actorTokens.push(req.headers["x-workflow-actor"]);
    const response = await fetch(new URL(req.url!, upstream), { method: req.method,
      headers: { Authorization: req.headers.authorization ?? "", "Content-Type": "application/json", ...(typeof req.headers["x-workflow-actor"] === "string" ? { "X-Workflow-Actor": req.headers["x-workflow-actor"] } : {}) },
      ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    const text = await response.text();
    if (state.dropReply && req.method === "POST" && req.url?.endsWith("/stop")) { req.socket.destroy(); return; }
    res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(text);
  }));
  const { app } = sessionsApi(), requests: { method: string | undefined; path: string | undefined }[] = [];
  const api = await listen(createServer((req, res) => { requests.push({ method: req.method, path: req.url }); app(req, res); }));
  const client = BarryClient.connect({ baseUrl: api, secret });
  const request = { reason: "Stop through authenticated selected session", request_id: randomUUID(), expected_revision: owner.workById(namespace, work.work_id)!.revision };
  const legacyStop = vi.fn(); runningAgents.set(work.action_id!, legacyStop);
  const stop = (credential: string | null = secret, selected = "owned", body: unknown = request) => fetch(`${api}/api/v1/actions/runs/${work.action_id}/cancel?session_id=${encodeURIComponent(selected)}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }) }, body: JSON.stringify(body) });
  const inspect = () => fetch(`${api}/api/v1/actions/runs/${work.action_id}?session_id=owned`, { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json;profile=barry-action-work-v1" } });
  const audits = () => owner.history(work.workflow_id).filter(event => event.type === "WorkStopRequested");
  return { owner, work, namespace, identity, foreignIdentity, stop, request, state, audits, legacyStop, rotateKey, seedSession, nativeWork, projection, inspect, client, requests };
}
it("authenticates the installation caller, selects the actual identity partition and signs one audited Stop", async () => {
  const f = await fixture();
  const inspected = await f.inspect(); expect(inspected.status).toBe(200);
  expect((await inspected.json()).workflow).toMatchObject({ work_id: f.work.work_id, revision: f.request.expected_revision, current: true });
  const first = await f.stop(); expect(first.status).toBe(202); const ack = await first.json();
  expect(ack).toMatchObject({ work_id: f.work.work_id, request_id: f.request.request_id, stop_requested: true });
  const duplicate = await f.stop(); expect(duplicate.status).toBe(202); expect(await duplicate.json()).toEqual(ack); expect(f.audits()).toHaveLength(1);
  expect(f.state.authorized).toEqual([f.identity, f.identity]); expect(JSON.stringify(f.audits())).toContain(f.request.reason);
  expect((await f.stop(secret, "owned", { ...f.request, reason: "different intent" })).status).toBe(409);
  expect(f.legacyStop).not.toHaveBeenCalled();
});
it("refuses missing/wrong credentials and unavailable selected partitions without owner control", async () => {
  const f = await fixture();
  for (const credential of [null, "wrong-secret"]) expect((await f.stop(credential)).status).toBe(401);
  for (const selected of ["missing", "foreign"]) expect((await f.stop(secret, selected)).status).toBe(404);
  expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]); expect(f.legacyStop).not.toHaveBeenCalled();
});
it("revalidates stored session bounds and upstream access, including accepted intent replay", async () => {
  const f = await fixture();
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[]}' WHERE id=2").run();
  expect((await f.stop()).status).toBe(403); expect(f.state.authorized).toEqual([]);
  identitiesSqlite().prepare("UPDATE identities SET metadata='{\"bags\":[\"workflows\"]}' WHERE id=2").run();
  f.state.revoked = true; expect((await f.stop()).status).toBe(403); expect(f.audits()).toEqual([]);
  f.state.revoked = false; expect((await f.stop()).status).toBe(202);
  f.state.revoked = true; expect((await f.stop()).status).toBe(403); expect(f.audits()).toHaveLength(1);
});
it("recovers a lost real owner reply with the same intent after declared actor-key rotation", async () => {
  const f = await fixture(); f.state.dropReply = true;
  const unknown = await f.stop(); expect(unknown.status).toBe(503);
  expect(await unknown.json()).toMatchObject({ error: "WorkStopUnknown", request_id: f.request.request_id, retryable: true });
  expect(f.audits()).toHaveLength(1);
  const rotated = firstKey + "-rotated"; f.rotateKey(rotated); f.state.dropReply = false;
  expect((await f.stop()).status).toBe(202); expect(f.audits()).toHaveLength(1);
  const token = f.state.actorTokens.at(-1)!, path = `/api/v2/work/${f.work.work_id}/stop`, signedBody = f.request;
  expect(verifyWorkflowActor(token, rotated, path, signedBody).principal).toBe(f.identity);
  expect(() => verifyWorkflowActor(token, firstKey, path, signedBody)).toThrow();
  expect(f.state.authorized).toEqual([f.identity, f.identity]); expect(f.legacyStop).not.toHaveBeenCalled();
});
it("refuses ambiguous real session locations before any owner control", async () => {
  const f = await fixture(); f.seedSession(f.foreignIdentity, "owned", 1, 1);
  expect((await f.stop()).status).toBe(500); expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]);
});
it("acknowledges Stop before proven native cessation and keeps capacity held until its receipt", async () => {
  const f = await fixture(true), native = f.nativeWork!;
  await native.waitStarted(); expect(native.reservation()).toBe(1); expect(native.childAlive()).toBe(true);
  await f.owner.publishWorkProjections(f.projection);
  const inspected = await f.inspect(); expect(inspected.status).toBe(200);
  f.request.expected_revision = (await inspected.json()).workflow.revision;
  expect((await f.stop()).status).toBe(202);
  expect(native.reservation()).toBe(1); expect(native.childAlive()).toBe(true);
  await native.waitCeased();
  expect(native.reservation()).toBe(0); expect(native.childAlive()).toBe(false);
  expect(native.receipt()).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(native.effectCount()).toBe(1); expect(f.audits()).toHaveLength(1); expect(f.legacyStop).not.toHaveBeenCalled();
}, 60_000);

it("refuses a real paired device credential before signing and observes its revocation", async () => {
  const f = await fixture(), devices = access.devices();
  const pending = devices.request({ clientName: "Control fixture", requestedScopes: ["actions:dispatch", "sessions:read"], requestedIdentityIds: [2] }, "combined-control-fixture");
  devices.authorize(pending.pairingCode, 2, { scopes: ["actions:dispatch", "sessions:read"], identityIds: [2] });
  const claim = devices.claim(pending.pollToken); if (claim.status !== "authorized") throw new Error("Device fixture pairing failed");
  expect((await f.stop(claim.deviceToken)).status).toBe(403);
  devices.revoke(2, claim.deviceId); expect((await f.stop(claim.deviceToken)).status).toBe(401);
  expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]); expect(f.legacyStop).not.toHaveBeenCalled();
});

it("uses the compiled SDK with one selected session for detail, Stop preflight and the dedicated Stop endpoint", async () => {
  const f = await fixture(), selection = { sessionId: "owned" };
  expect(await f.client.actions.getRun(f.work.action_id!, { sessionId: "foreign" })).toBeNull();
  f.requests.length = 0;
  const run = await f.client.actions.getRun(f.work.action_id!, selection);
  expect(run?.work).toMatchObject({ workId: f.work.work_id, current: true });
  const intent = { reason: f.request.reason, requestId: f.request.request_id, expectedRevision: run!.work!.revision };
  const first = await f.client.actions.stopWorkflowRun(f.work.action_id!, intent, selection);
  expect(first).toMatchObject({ runId: f.work.action_id, workId: f.work.work_id, requestId: intent.requestId, stopRequested: true, status: "stop_requested" });
  expect(await f.client.actions.stopWorkflowRun(f.work.action_id!, intent, selection)).toEqual(first);
  expect(f.audits()).toHaveLength(1); expect(f.state.authorized).toEqual([f.identity, f.identity]); expect(f.legacyStop).not.toHaveBeenCalled();
  const paths = f.requests.map(request => new URL(request.path!, "http://fixture"));
  expect(paths).toHaveLength(5);
  expect(paths.every(path => path.searchParams.get("session_id") === "owned")).toBe(true);
  expect(f.requests.filter(request => request.method === "POST").map(request => new URL(request.path!, "http://fixture").pathname))
    .toEqual([`/api/v1/actions/runs/${f.work.action_id}/work-stop`, `/api/v1/actions/runs/${f.work.action_id}/work-stop`]);
});

it("recovers a compiled SDK Stop after real reply loss and actor-key rotation using the original selected session and intent", async () => {
  const f = await fixture(), selection = { sessionId: "owned" };
  const run = await f.client.actions.getRun(f.work.action_id!, selection);
  const intent = { reason: f.request.reason, requestId: f.request.request_id, expectedRevision: run!.work!.revision };
  f.state.dropReply = true;
  await expect(f.client.actions.stopWorkflowRun(f.work.action_id!, intent, selection)).rejects.toMatchObject({ status: 503, code: "WorkStopUnknown" });
  expect(f.audits()).toHaveLength(1);
  const rotated = firstKey + "-sdk-rotated"; f.rotateKey(rotated); f.state.dropReply = false;
  expect(await f.client.actions.stopWorkflowRun(f.work.action_id!, intent, selection)).toMatchObject({ requestId: intent.requestId, stopRequested: true, status: "stop_requested" });
  const token = f.state.actorTokens.at(-1)!, path = `/api/v2/work/${f.work.work_id}/stop`;
  const wire = { reason: intent.reason, request_id: intent.requestId, expected_revision: intent.expectedRevision };
  expect(verifyWorkflowActor(token, rotated, path, wire).principal).toBe(f.identity);
  expect(() => verifyWorkflowActor(token, firstKey, path, wire)).toThrow();
  expect(f.audits()).toHaveLength(1); expect(f.state.authorized).toEqual([f.identity, f.identity]); expect(f.legacyStop).not.toHaveBeenCalled();
});

it("keeps native capacity held after compiled SDK Stop acknowledgement until the actual child ceases", async () => {
  const f = await fixture(true), native = f.nativeWork!, selection = { sessionId: "owned" };
  await native.waitStarted(); await f.owner.publishWorkProjections(f.projection);
  const run = await f.client.actions.getRun(f.work.action_id!, selection);
  expect(native.reservation()).toBe(1); expect(native.childAlive()).toBe(true);
  expect(await f.client.actions.stopWorkflowRun(f.work.action_id!, { reason: f.request.reason, requestId: f.request.request_id, expectedRevision: run!.work!.revision }, selection))
    .toMatchObject({ workId: f.work.work_id, stopRequested: true, status: "stop_requested" });
  expect(native.reservation()).toBe(1); expect(native.childAlive()).toBe(true);
  await native.waitCeased();
  expect(native.receipt()).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(native.reservation()).toBe(0); expect(native.childAlive()).toBe(false); expect(native.effectCount()).toBe(1);
  expect(f.audits()).toHaveLength(1); expect(f.legacyStop).not.toHaveBeenCalled();
}, 60_000);
