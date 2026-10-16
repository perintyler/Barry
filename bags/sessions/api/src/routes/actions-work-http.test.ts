import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { workflowActorSigner } from "@barry-rocks/sdk/internal/auth";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { WorkflowOwner, WorkArtifactStore, ProcessExecutor, WorkAdmissionService, WorkControlService, inspectArtifact, WorkflowError, publicError, type WorkResolution } from "@barry-rocks/sdk/internal/workflows";
import { createActionWorkProjection, setDb, closeDb } from "@barry-rocks/actions-bag";
import { getDb } from "@barry-rocks/actions-bag/db";
import { createWorkflowServer } from "@barry-rocks/workflows-bag";

const addresses = vi.hoisted(() => ({ owner: "" }));
vi.mock("@barry-rocks/sdk/services", async original => ({ ...await original<typeof import("@barry-rocks/sdk/services")>(),
  serviceAddress: (name: string) => { if (name === "workflows.runtime") return addresses.owner; throw new Error("unconfigured fixture service"); },
}));
vi.mock("./actions-executor.js", () => ({ executeDetached: vi.fn(), stopDetachedRun: vi.fn() }));
import { actionsRouter } from "./actions.js";

const cleanup: (() => void | Promise<void>)[] = [];
const retainedRoots = new Set<string>();
const fixtureRoots = new Set<string>();
const observations: { root: string; events: unknown[]; backup(): void }[] = [];
afterEach(async context => {
  const cleanupErrors: unknown[] = [];
  try {
    if (context.task.result?.state === "fail") {
      for (const root of fixtureRoots) retainedRoots.add(root);
      for (const observation of observations) {
        retainedRoots.add(observation.root);
        try { observation.backup(); }
        catch (error) { observation.events.push({ kind: "diagnostic-backup-failed", message: String(error).slice(0, 2000) }); }
        try {
          writeFileSync(join(observation.root, "failure-diagnostics.json"), JSON.stringify({ test: context.task.name, events: observation.events }, null, 2), { mode: 0o600 });
          console.error("ACTION_WORK_HTTP_FAILURE_PRESERVED", observation.root);
        } catch { /* Diagnostic failure must not mask the test or prevent cleanup. */ }
      }
    }
  } finally {
    for (const close of cleanup.splice(0).reverse()) {
      try { await close(); } catch (error) {
        cleanupErrors.push(error);
        for (const root of fixtureRoots) retainedRoots.add(root);
      }
    }
    try { closeDb(); } catch (error) {
      cleanupErrors.push(error);
      for (const root of fixtureRoots) retainedRoots.add(root);
    }
    for (const root of fixtureRoots) {
      try { if (!retainedRoots.has(root)) rmSync(root, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); retainedRoots.add(root); }
    }
    fixtureRoots.clear();
    vi.unstubAllEnvs();
    observations.splice(0);
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "HTTP fixture cleanup failed");
});
async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Real HTTP actor verification and control service; admission is a trusted fixture.
 * A waiting timer keeps the persisted owner live without claiming activity cessation. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actions-work-http-")); fixtureRoots.add(root);
  const events: unknown[] = [];
  const observe = (event: unknown) => { if (events.length < 100) events.push(event); };
  const file = join(root, "workflow.mjs"); writeFileSync(file, "export const definitions=[{type:'action-http',version:'1',*run(input){yield {kind:'timer',delayMs:60000};return input;}}];");
  const artifact = inspectArtifact(file, "action-http", "1"), artifacts = new WorkArtifactStore(join(root, "artifacts")); cleanup.push(() => artifacts.close());
  const source = artifacts.stage(readFileSync(file), { purpose: "source", media_type: "text/javascript", owner_identity: null });
  const scope = await approveWorkflowBounds({ identity: "alice", bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const namespace = { installation: "owner", principal_kind: "identity" as const, principal_id: "alice", identity_id: "identity-alice", caller_session_id: "session-alice" };
  const origin = { entry_point: "fixture", trigger: "manual" as const, caller_session_id: "session-alice" }, authority = { namespace, origin, run_identity: "alice", caller_ceiling: scope };
  const grant = { version: 2 as const, grant_ref: "fixture", revision: 1, namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const ownerPath = join(root, "owner.db"), owner = new WorkflowOwner({ id: "owner", path: ownerPath, artifacts: [artifact], executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const admission = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async (input): Promise<WorkResolution> => ({ title: "HTTP identity fixture", grant, workflow_input: input.inputs, plan: {
    version: 2, definition: input.definition, workflow: { type: artifact.type, version: artifact.version, artifact_digest: artifact.digest, runtime_abi: artifact.abi, input_digest: boundFingerprint(input.inputs) }, source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable", effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 10000 }, validation: { mode: "none" },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner", host_reservation: null, endpoint: null }, workspace: { kind: "none" }, selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 10000, dispatch_budget_ms: 60000,
  } }) });
  const work = await admission.submit({ version: 2, request_id: randomUUID(), idempotency_key: "fixture", authority_ref: "fixture", origin, definition: { kind: "action", reference: "fixture:http", catalog_namespace: "fixture" }, inputs: {} }, null);
  await owner.pump();
  const context = { identity: "identity-alice" }, actionPath = join(root, "actions.db"), db = new Database(actionPath);
  vi.stubEnv("BARRY_ACTIONS_DB", actionPath);
  withStoreContext(context, () => { setDb(db); getDb(); });
  observations.push({ root, events, backup: () => {
    // Preserve crash-state bytes without asynchronous online backup work during failure cleanup.
    for (const [source, target] of [[ownerPath, "failure-owner.db"], [actionPath, "failure-actions.db"]]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(source + suffix)) copyFileSync(source + suffix, join(root, target + suffix));
      }
    }
  } });
  const target = createActionWorkProjection({ database: db, namespace, result: value => owner.workResult({ kind: "namespace", namespace }, value.work_id) });
  await owner.publishWorkProjections(target);
  const key = "identity-http-fixture-key-longer-than-32-bytes";
  const state = { principal: "alice", revoked: false, corrupt: false, contextIdentity: true, authorized: [] as (string | null)[] };
  const controls = new WorkControlService<string | null>({ owner, authorize: async principal => {
    state.authorized.push(principal);
    if (principal === null) throw new WorkflowError("RootFallbackForbidden", "Identity fixture must never use operator authority.", 403);
    return { actor: principal, scope: { kind: "identity", installation: "owner", identity_id: principal === "alice" ? "identity-alice" : "identity-other" }, controls: ["stop"] };
  } });
  const originalScopedWork = owner.scopedWork.bind(owner);
  owner.scopedWork = (...args: Parameters<typeof owner.scopedWork>) => {
    const result = originalScopedWork(...args);observe({ kind: "scoped-work", scope: args[0], workId: args[1], found: result !== null && result !== undefined, resultType: result === null ? "null" : typeof result });return result;
  };
  const originalStop = controls.stop.bind(controls);
  controls.stop = async (...args: Parameters<typeof controls.stop>) => {
    observe({ kind: "control-entered", principal: args[2], workId: args[0] });
    try { return await originalStop(...args); }
    catch (error) {
      const value = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; constructor?: { name?: string } };
      observe({ kind: "control-error", name: String(value?.name), code: value?.code, status: value?.status, message: String(value?.message).slice(0, 2000), constructor: value?.constructor?.name,
        workflowErrorInstance: error instanceof WorkflowError, publicError: publicError(error) });
      throw error;
    }
  };
  const workflowServer = createWorkflowServer({ owner, secret: "http-fixture-hop", authenticateWorker: () => null, actorKey: key,
    grants: () => ({ ...(!state.revoked ? { alice: { types: ["action-http"], operations: ["get" as const, "cancel" as const], payloadRead: false } } : {}), other: { types: ["action-http"], operations: ["get", "cancel"], payloadRead: false } }), workControls: controls,
  });
  workflowServer.prependListener("request", (request, response) => {
    let body = "";
    const append = (chunk: unknown) => { if (body.length < 16384 && (typeof chunk === "string" || Buffer.isBuffer(chunk))) body = (body + chunk.toString()).slice(0, 16384); };
    const write = response.write, end = response.end;
    response.write = function (this: typeof response, ...args: unknown[]) { append(args[0]);return Reflect.apply(write, this, args); } as typeof response.write;
    response.end = function (this: typeof response, ...args: unknown[]) { append(args[0]);return Reflect.apply(end, this, args); } as typeof response.end;
    response.once("finish", () => observe({ kind: "owner-http-response", path: request.url, status: response.statusCode, body }));
  });
  addresses.owner = await listen(workflowServer);
  vi.stubEnv("BARRY_SECRET", "http-fixture-hop");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "authPrincipal", { value: { kind: "installation", actorId: 1, credentialId: "fixture-installation" } });
    withStoreContext({ ...(state.contextIdentity ? context : {}), workflowActor: (path: string, body?: unknown) => {
      const token = workflowActorSigner({ identity: state.principal, bags: [], bounds: [], bound: null, allowedToolIds: ["workflows:cancel"] }, key)(path, body);
      return state.corrupt ? `${token}invalid` : token;
    } }, next);
  });
  app.use("/actions", actionsRouter);
  const errorObserver: import("express").ErrorRequestHandler = (error, _request, _response, next) => {
    observe({ kind: "express-error", name: error?.name, message: String(error?.message).slice(0, 2000), code: error?.code });next(error);
  };
  app.use(errorObserver);
  const api = await listen(createServer(app)), request = { reason: "Stop signed identity fixture", request_id: randomUUID(), expected_revision: owner.workById(namespace, work.work_id)!.revision };
  const stop = async (body: unknown = request, query = "") => {
    const response = await fetch(`${api}/actions/runs/${work.action_id}/cancel${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    observe({ kind: "actions-http-response", status: response.status });return response;
  };
  const audits = () => { const connection = new Database(ownerPath, { readonly: true }); try { return connection.prepare("SELECT details FROM workflow_events WHERE run_id=? AND type='WorkStopRequested'").all(work.workflow_id).map(row => JSON.parse((row as { details: string }).details)); } finally { connection.close(); } };
  return { owner, work, request, stop, state, audits };
}

it("forwards a signed identity Stop through production HTTP verification and replays one persisted audited intent", async () => {
  const f = await fixture();
  const first = await f.stop(); expect(first.status).toBe(202);
  const ack = await first.json(); expect(ack).toMatchObject({ work_id: f.work.work_id, request_id: f.request.request_id, stop_requested: true, status: "stop_requested" });
  const duplicate = await f.stop(); expect(duplicate.status).toBe(202); expect(await duplicate.json()).toEqual(ack);
  expect(f.state.authorized).toEqual(["alice", "alice"]);
  expect(f.audits()).toEqual([expect.objectContaining({ actor: "alice", reason: f.request.reason })]);
  expect((await f.stop({ ...f.request, reason: "changed intent" })).status).toBe(409); expect(f.audits()).toHaveLength(1);
});

it("checks the current workflow grant before control, including a previously accepted duplicate", async () => {
  const f = await fixture(); f.state.revoked = true;
  expect((await f.stop()).status).toBe(403); expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]);
  f.state.revoked = false; expect((await f.stop()).status).toBe(202); expect(f.audits()).toHaveLength(1);
  f.state.revoked = true; expect((await f.stop()).status).toBe(403); expect(f.state.authorized).toEqual(["alice"]); expect(f.audits()).toHaveLength(1);
});

it("refuses a different signed identity even when the Actions route can inspect the original history row", async () => {
  const f = await fixture(); f.state.principal = "other";
  expect((await f.stop()).status).toBe(404); expect(f.state.authorized).toEqual(["other"]); expect(f.audits()).toEqual([]);
  f.state.principal = "alice"; expect((await f.stop()).status).toBe(202); expect(f.audits()).toHaveLength(1);
});

it("rejects a corrupted actor signature before authorizing any owner control", async () => {
  const f = await fixture(); f.state.corrupt = true;
  expect((await f.stop()).status).toBe(403); expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]);
});

it("never bypasses an unresolved explicitly selected query session using operator authority or a host signer", async () => {
  const f = await fixture(); f.state.contextIdentity = false;
  expect((await f.stop(f.request, "?session_id=unresolved-session")).status).toBe(403);
  expect(f.state.authorized).toEqual([]); expect(f.audits()).toEqual([]);
  expect(f.owner.get(f.work.workflow_id).status).toBe("running");
});
