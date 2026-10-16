import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import { withStoreContext, type StoreContext } from "@barry-rocks/sdk/internal/stores";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
const addresses = vi.hoisted(() => ({ owner: "" }));
vi.mock("@barry-rocks/sdk/services", async original => ({ ...await original<typeof import("@barry-rocks/sdk/services")>(),
  serviceAddress: (name: string) => { if (name === "workflows.runtime") return addresses.owner; throw new Error("unconfigured fixture service"); },
}));
vi.mock("./actions-executor.js", () => ({ executeDetached: vi.fn(), stopDetachedRun: vi.fn() }));
import { WorkflowOwner, WorkArtifactStore, ProcessExecutor, WorkAdmissionService, inspectArtifact, publicError, type WorkResolution } from "@barry-rocks/sdk/internal/workflows";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { ActionRuns, createActionWorkProjection, setDb, closeDb } from "@barry-rocks/actions-bag";
import { actionsRouter } from "./actions.js";
import { runningAgents } from "./actions-executor-support.js";
import { stopWorkflowAction } from "./actions-work-control.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); closeDb(); vi.unstubAllEnvs(); vi.restoreAllMocks(); runningAgents.clear(); });
async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(host: { principal?: express.Request["authPrincipal"]; context?: StoreContext; waiting?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "action-wrapper-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "workflow.mjs"); writeFileSync(file, `export const definitions=[{type:'action-fixture',version:'1',*run(input){${host.waiting ? "yield {kind:'timer',delayMs:60000};" : ""}return input;}}];`);
  const artifact = inspectArtifact(file, "action-fixture", "1"), artifacts = new WorkArtifactStore(join(root, "artifacts")); cleanup.push(() => artifacts.close());
  const source = artifacts.stage(readFileSync(file), { purpose: "source", media_type: "text/javascript", owner_identity: null });
  const scope = await approveWorkflowBounds({ bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const namespace = { installation: "owner", principal_kind: "operator" as const, principal_id: "local-operator", identity_id: null, caller_session_id: null };
  const origin = { entry_point: "fixture", trigger: "manual" as const }, authority = { namespace, origin, run_identity: null, caller_ceiling: scope };
  const grant = { version: 2 as const, grant_ref: "fixture", revision: 1, namespace, authorizer: "local-operator", created_by: "local-operator", approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const owner = new WorkflowOwner({ id: "owner", path: join(root, "owner.db"), artifacts: [artifact], executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const service = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async (input): Promise<WorkResolution> => ({ title: "Fixture", grant, workflow_input: input.inputs, plan: {
    version: 2, definition: input.definition, workflow: { type: artifact.type, version: artifact.version, artifact_digest: artifact.digest, runtime_abi: artifact.abi, input_digest: boundFingerprint(input.inputs) }, source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable", effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 10000 }, validation: { mode: "none" },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner", host_reservation: null, endpoint: null }, workspace: { kind: "none" }, selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 10000, dispatch_budget_ms: 60000,
  } }) });
  const work = await service.submit({ version: 2, request_id: randomUUID(), idempotency_key: "fixture", authority_ref: "fixture", origin, definition: { kind: "action", reference: "fixture:report", catalog_namespace: "fixture" }, inputs: {} }, null);
  setDb(new Database(join(root, "actions.db")));
  const { getDb } = await import("@barry-rocks/actions-bag/db");
  const target = createActionWorkProjection({ database: getDb(), namespace, result: value => owner.workResult({ kind: "namespace", namespace }, value.work_id) });
  await owner.publishWorkProjections(target);
  const transport = { lose: false, mismatch: false, badAckRevision: false, posts: [] as Record<string, unknown>[] };
  addresses.owner = await listen(createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== "Bearer wrapper-test") { json(403, {}); return; }
    const path = req.url?.replace(/^\/workflow-proxy/, "");
    if (path === "/api/metadata") { json(200, { installation: transport.mismatch ? "other-owner" : owner.id }); return; }
    if (path !== `/api/v2/work/${work.work_id}/stop`) { json(404, {}); return; }
    try {
      let raw = ""; for await (const bytes of req) raw += String(bytes); const body = JSON.parse(raw); transport.posts.push(body);
      const ack = owner.stopWork(work.work_id, body, "local-operator");
      if (transport.lose) { req.socket.destroy(); return; }
      json(200, transport.badAckRevision ? { ...ack, applied_revision: body.expected_revision - 1 } : ack);
    } catch (error) { const value = publicError(error); json(value.status, value.body); }
  }));
  vi.stubEnv("BARRY_SECRET", "wrapper-test");
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "authPrincipal", { value: host.principal }); withStoreContext(host.context ?? {}, next); });
  app.use("/actions", actionsRouter);
  const api = await listen(createServer(app));
  const request = { reason: "Stop fixture", request_id: randomUUID(), expected_revision: work.revision };
  const stop = (body: unknown = request, id = work.action_id!) => fetch(`${api}/actions/runs/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { owner, ownerPath: join(root, "owner.db"), namespace, work, api, request, stop, target, transport };
}
it("exposes a small work reference on list/detail and never invokes a legacy stop for workflow rows", async () => {
  const f = await fixture(), legacyStop = vi.fn(); runningAgents.set(f.work.action_id!, legacyStop);
  const detail = await (await fetch(`${f.api}/actions/runs/${f.work.action_id}`, { headers: { Accept: "application/json;profile=barry-action-work-v1" } })).json();
  expect(detail.workflow).toMatchObject({ work_id: f.work.work_id, current: true, state: "queued" });
  expect(detail.workflow.url).toBe(`${addresses.owner}/work#work/${f.work.work_id}`); expect(detail.workflow).not.toHaveProperty("result");
  expect((await (await fetch(`${f.api}/actions/runs`, { headers: { Accept: "application/json;profile=barry-action-work-v1" } })).json()).runs[0].workflow).not.toHaveProperty("result");
  expect((await f.stop({ reason: "old client" })).status).toBe(422); expect(legacyStop).not.toHaveBeenCalled();
  const accepted = await f.stop(); expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ stop_requested: true, status: "stop_requested", request_id: f.request.request_id });
  expect(legacyStop).not.toHaveBeenCalled();
  const duplicate = await f.stop(); expect(duplicate.status).toBe(202);
  expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
  expect(f.transport.posts).toEqual([f.request, f.request]);
  expect(JSON.stringify(f.owner.history(f.work.workflow_id))).toContain(f.request.reason);
  expect((await f.stop({ ...f.request, reason: "different intent" })).status).toBe(409);
  await f.owner.publishWorkProjections(f.target);
  expect((await (await fetch(`${f.api}/actions/runs/${f.work.action_id}`, { headers: { Accept: "application/json;profile=barry-action-work-v1" } })).json()).workflow.state).toBe("cancelled");
});
it("preserves an unconfirmed stop key/revision/reason after a committed upstream reply is lost", async () => {
  const f = await fixture(); f.transport.lose = true;
  const unknown = await f.stop(); expect(unknown.status).toBe(503); expect(await unknown.json()).toMatchObject({ retryable: true, request_id: f.request.request_id });
  f.transport.lose = false; expect((await f.stop()).status).toBe(202);
  expect(f.transport.posts).toEqual([f.request, f.request]); expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
});
it("refuses wrong owners, scoped callers without a signer, empty signer results and legacy IDs without control effects", async () => {
  const f = await fixture(), row = (await ActionRuns.get(f.work.action_id!))!;
  f.transport.mismatch = true; expect((await f.stop()).status).toBe(409); expect(f.transport.posts).toEqual([]);
  await expect(stopWorkflowAction(row, f.request, { operator: false })).rejects.toMatchObject({ status: 403 });
  await expect(stopWorkflowAction(row, f.request, { operator: false, actor: () => "" })).rejects.toMatchObject({ status: 403 });
  const legacy = await ActionRuns.create({ action: "legacy", bag: "fixture" }), stop = vi.fn(); runningAgents.set(legacy.id, stop);
  expect((await f.stop(f.request, legacy.id)).status).toBe(409); expect(stop).not.toHaveBeenCalled();
  expect(f.owner.get(f.work.workflow_id).status).toBe("running");
});

it("preserves a configured reverse-proxy prefix for Work links and Stop forwarding", async () => {
  const f = await fixture(); addresses.owner += "/workflow-proxy";
  const detail = await (await fetch(`${f.api}/actions/runs/${f.work.action_id}`, { headers: { Accept: "application/json;profile=barry-action-work-v1" } })).json();
  expect(detail.workflow.url).toBe(`${addresses.owner}/work#work/${f.work.work_id}`);
  expect((await f.stop()).status).toBe(202);
});

it("keeps legacy strict-reader responses free of workflow fields without the response profile", async () => {
  const f = await fixture();
  const detail = await fetch(`${f.api}/actions/runs/${f.work.action_id}`);
  expect(await detail.json()).not.toHaveProperty("workflow"); expect(detail.headers.get("vary")).toContain("Accept");
  const page = await (await fetch(`${f.api}/actions/runs`)).json(); expect(page.runs[0]).not.toHaveProperty("workflow");
});

it("refuses a device at the route boundary even when host context has a signer", async () => {
  const signer = vi.fn(() => "must-not-be-used");
  const f = await fixture({ principal: { kind: "device", credentialId: "paired", actorId: 1, identityIds: [7], scopes: ["actions:dispatch"] }, context: { workflowActor: signer } });
  expect((await f.stop()).status).toBe(403); expect(signer).not.toHaveBeenCalled(); expect(f.transport.posts).toEqual([]);
});
it("does not expose or control operator history from an identity context", async () => {
  const f = await fixture({ context: { identity: "identity-seven" } });
  expect((await f.stop()).status).toBe(404); expect(f.transport.posts).toEqual([]);
});

it("keeps the Stop unconfirmed when an upstream acknowledgement predates its inspected revision", async () => {
  const f = await fixture({ waiting: true });
  await f.owner.pump(); await f.owner.publishWorkProjections(f.target);
  f.request.expected_revision = f.owner.workById(f.namespace, f.work.work_id)!.revision;
  expect(f.request.expected_revision).toBeGreaterThan(1);
  f.transport.badAckRevision = true;
  const unknown = await f.stop(); expect(unknown.status).toBe(503);
  expect(await unknown.json()).toMatchObject({ error: "WorkStopUnknown", request_id: f.request.request_id, retryable: true });
  f.transport.badAckRevision = false; expect((await f.stop()).status).toBe(202);
  expect(f.transport.posts).toEqual([f.request, f.request]);
  expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
});

it("reserves encoded Stop audit bytes and rolls back refusal before retrying the same intent", async () => {
  const f = await fixture(), db = new Database(f.ownerPath);
  cleanup.push(() => { db.close(); });
  // Inject storage pressure at the last pre-receipt boundary. Escaped reason
  // bytes must fit alongside the receipt; raw character length is insufficient.
  db.exec(`CREATE TRIGGER stop_quota_pressure AFTER INSERT ON workflow_events
    WHEN NEW.type='WorkStopRequested' BEGIN
      UPDATE workflow_meta SET value='1073721824' WHERE key='reserved-bytes';
    END`);
  const request = { ...f.request, reason: "\u0001".repeat(2000) };
  const refused = await f.stop(request);
  expect(refused.status).toBe(429);
  expect(await refused.json()).toMatchObject({ error: "CapacityExceeded", retryable: true });
  expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(0);
  expect(f.owner.get(f.work.workflow_id).status).toBe("running");
  const budget = db.prepare("SELECT value FROM workflow_meta WHERE key='reserved-bytes'").get() as { value: string };
  expect(Number(budget.value)).toBeLessThan(1073741824);
  db.exec("DROP TRIGGER stop_quota_pressure");
  expect((await f.stop(request)).status).toBe(202);
  expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
});

it("reserves both Stop audit and receipt row overhead before storing an acknowledgement", async () => {
  const f = await fixture(), db = new Database(f.ownerPath);
  cleanup.push(() => { db.close(); });
  // Check the actual debit at the durable write boundary, against the rows'
  // encoded sizes and the same event/receipt allowances used by settlement.
  db.exec(`CREATE TABLE stop_budget_checkpoint(run_id TEXT PRIMARY KEY, reserved INTEGER, audit_bytes INTEGER);
    CREATE TRIGGER capture_stop_budget AFTER INSERT ON workflow_events
    WHEN NEW.type='WorkStopRequested' BEGIN
      INSERT INTO stop_budget_checkpoint VALUES(NEW.run_id,
        CAST((SELECT value FROM workflow_meta WHERE key='reserved-bytes') AS INTEGER),
        length(CAST(NEW.details AS BLOB)));
    END;
    CREATE TRIGGER stop_budget_admission BEFORE INSERT ON workflow_work_stop_receipts BEGIN
      SELECT CASE WHEN
        CAST((SELECT value FROM workflow_meta WHERE key='reserved-bytes') AS INTEGER) -
        (SELECT reserved FROM stop_budget_checkpoint WHERE run_id=NEW.run_id) <
        length(CAST(NEW.request AS BLOB)) + length(CAST(NEW.response AS BLOB)) +
        (SELECT audit_bytes FROM stop_budget_checkpoint WHERE run_id=NEW.run_id) + 768
      THEN RAISE(ABORT,'Stop audit and receipt bytes must be reserved before acknowledgement') END;
    END;`);
  expect((await f.stop()).status).toBe(202);
  expect(f.owner.history(f.work.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
});

it("keeps the dedicated session Stop endpoint away from missing selectors and legacy cancellation", async () => {
  const f = await fixture(), legacy = await ActionRuns.create({ action: "legacy", bag: "fixture" }), stop = vi.fn();
  runningAgents.set(legacy.id, stop);
  const send = (id: string, query = "") => fetch(`${f.api}/actions/runs/${id}/work-stop${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f.request) });
  expect((await send(f.work.action_id!)).status).toBe(422);
  expect((await send(f.work.action_id!, "?session_id=one&session_id=two")).status).toBe(422);
  expect((await send(legacy.id, "?session_id=owned")).status).toBe(409);
  expect(stop).not.toHaveBeenCalled(); expect(f.transport.posts).toEqual([]);
});
