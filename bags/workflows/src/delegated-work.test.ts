import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import {
  WorkflowError,
  WorkflowOwner,
  ProcessExecutor,
  WorkArtifactStore,
  WorkAdmissionService,
  WorkReadService,
  WorkControlService,
  WorkResourceBroker, ExecutorJournal, executionBindingSchema, logicalStageEffectKey, workReceiptDigest,
  WorkDelegationIssuer,
  WorkDelegationVerifier,
  inspectArtifact,
  type WorkAuthority,
  type WorkSubmission,
  type WorkResolution,
} from "@barry-rocks/sdk/internal/workflows";
import { workflowActorSigner } from "@barry-rocks/sdk/internal/auth";
import { createWorkflowServer } from "./server.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(outputs = false) {
  const root = mkdtempSync(join(tmpdir(), "delegated-work-http-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = fileURLToPath(
    new URL("../../../sdk/src/workflows/execution-fixture.mjs", import.meta.url),
  );
  const artifact = inspectArtifact(path, "echo", "1"),
    artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const source = artifacts.stage(readFileSync(path), {
    owner_identity: null,
    purpose: "source",
    media_type: "text/javascript",
  });
  const broker = new WorkResourceBroker({ path: join(root, "broker.db"), broker: "owner", limits: { local: { kind: "host" } } });
  cleanup.push(() => broker.close());
  const owner = new WorkflowOwner({
    id: "owner",
    path: join(root, "owner.db"),
    artifacts: [artifact],
    activityArtifacts: { echo: artifact.digest },
    executor: new ProcessExecutor(),
    workArtifacts: artifacts,
    authorizeWork: () => revoked ? null : scope,
    workResources: { brokers: new Map([[broker.id, broker]]), host: () => ({ broker: "owner", resource: "local" }) },
  });
  cleanup.push(async () => {
    await owner.drain();
    owner.close();
  });
  const scope = await approveWorkflowBounds({
    identity: "alice",
    bags: [],
    tools: [],
    bounds: [{ files: { allow: [] }, nodes: { allow: ["local"] } }],
    boundByName: async () => undefined,
  });
  const request: WorkSubmission = {
    version: 2,
    request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05437",
    idempotency_key: "http-invocation",
    authority_ref: "verified-session-grant",
    definition: { kind: "workflow", reference: "echo", version: "1" },
    inputs: "hello",
    origin: { entry_point: "action-run", trigger: "invocation", caller_session_id: "session" },
  };
  const authority: WorkAuthority = {
    namespace: {
      installation: "owner",
      principal_kind: "identity",
      principal_id: "alice",
      identity_id: "identity-uuid",
      caller_session_id: "session",
    },
    caller_ceiling: scope,
    origin: request.origin,
    run_identity: "alice",
  };
  const now = Date.now(),
    key = {
      id: "delegation-key",
      secret: "fixture-only-dedicated-delegation-key-0000",
      not_before: now - 1000,
      not_after: now + 3600000,
    };
  const issuer = new WorkDelegationIssuer({
    path: join(root, "issuer.db"),
    issuer: "sessions.api",
    signingKey: () => key,
  });
  cleanup.push(() => issuer.close());
  issuer.register(request, authority, {
    kind: "session",
    definition_owner_session: "session",
    background_parent: false,
  });
  let revoked = false, draining = false;
  const verifier = new WorkDelegationVerifier({
    installation: "owner",
    keys: (issuer) => (issuer === "sessions.api" ? [key] : []),
    authorizeIssuer: record => record.issuer === "sessions.api" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity",
    currentPolicy: async () => {
      if (revoked) throw new WorkflowError("AuthorityRevoked", "Caller policy revoked.", 403);
      return scope;
    },
  });
  const workAdmission = new WorkAdmissionService({
    owner,
    authenticate: verifier.authenticate.bind(verifier),
    resolve: async (request, authenticated): Promise<WorkResolution> => {
      const grant = {
        version: 2 as const,
        grant_ref: "accepted-grant",
        revision: 1,
        namespace: authenticated.namespace,
        authorizer: "alice",
        created_by: "alice",
        approved_at: Date.now(),
        original_caller_ceiling: authenticated.caller_ceiling,
        effective_scope: authenticated.caller_ceiling,
        definition_bounds_digest: boundFingerprint(scope.bound),
        policy_revision: "policy-1",
      };
      return {
        grant,
        title: "HTTP delegated task",
        workflow_input: request.inputs,
        plan: {
          version: 2,
          definition: request.definition,
          workflow: {
            type: "echo",
            version: "1",
            artifact_digest: artifact.digest,
            runtime_abi: artifact.abi,
            input_digest: boundFingerprint(request.inputs),
          },
          source_closure: [source],
          grant_ref: grant.grant_ref,
          grant_revision: 1,
          grant_digest: boundFingerprint(grant),
          executor_generation: "work-v2",
          execution_profile: "portable",
          effect_policy: { class: "non-repeatable", max_attempts: 1 },
          resources: {
            executor: "process",
            lane: "unscheduled",
            logical_reservation: "owner-assigned",
            host_reservation: null,
            endpoint: null,
          },
          workspace: { kind: "none" },
          selection: {
            requested_model: null,
            resolved_model: null,
            endpoint: null,
            requested_harness: null,
            resolved_harness: null,
            provenance: "definition",
          },
          execution_budget_ms: 60000,
          dispatch_budget_ms: 120000,
        },
      };
    },
  });
  const server = createWorkflowServer({
    owner,
    secret: "fixture-service-hop",
    authenticateWorker: (credential) => (credential.startsWith("barry_wk_") ? "worker" : null),
    workAdmission,
    draining: () => draining,
    actorKey: "work-read-fixture-actor-key-longer-than-32-bytes",
    grants: () => ({ alice: { types: ["echo"], operations: outputs ? ["get", "list", "cancel", "resume"] : ["get", "list"], payloadRead: outputs }, other: { types: ["echo"], operations: outputs ? ["get", "list", "cancel", "resume"] : ["get", "list"], payloadRead: outputs }, startOnly: { types: ["echo"], operations: ["start"], payloadRead: false } }),
    workControls: new WorkControlService<string | null>({ owner, authorize: async principal => {
      if (revoked) throw new WorkflowError("ControlRevoked", "Caller policy revoked.", 403);
      return { actor: principal ?? "local-operator", scope: principal === null ? { kind: "installation", installation: "owner" } : { kind: "identity", installation: "owner", identity_id: principal === "alice" ? "identity-uuid" : "other-uuid" }, controls: outputs ? ["stop", ...(principal === null ? ["reconcile" as const] : [])] : [] };
    } }),
    workReads: new WorkReadService<string | null>({ owner, authorize: async principal => {
      if (revoked) throw new WorkflowError("ReadRevoked", "Caller policy revoked.", 403);
      return { scope: principal === null ? { kind: "installation", installation: "owner" } : { kind: "identity", installation: "owner", identity_id: principal === "alice" ? "identity-uuid" : "other-uuid" }, controls: outputs ? ["inspect", "result", "stop"] : ["inspect"] };
    } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2/work/submissions`;
  const call = (body: unknown, token = "fixture-service-hop") =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return {
    root, artifact, artifacts,
    write: (path: string, body: unknown, actor?: string) => fetch(new URL(path, url), { method: "POST", headers: { Authorization: "Bearer fixture-service-hop", "Content-Type": "application/json", ...(actor ? { "x-workflow-actor": actor } : {}) }, body: JSON.stringify(body) }),
    read: (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, url), { headers: { Authorization: "Bearer fixture-service-hop", ...headers } }),
    owner,
    request,
    authority,
    issuer,
    call,
    beginDrain: () => { draining = true; },
    revoke: () => {
      revoked = true;
    },
  };
}
it("uses real HTTP delegation, preserves the caller, and reports first acceptance versus duplicate", async () => {
  const f = await fixture(),
    body = { request: f.request, delegation: f.issuer.issue(f.request, f.authority) };
  const first = await f.call(body);
  expect(first.status).toBe(201);
  const accepted = (await first.json()).work;
  expect(accepted.namespace.principal_id).toBe("alice");
  expect(accepted.namespace.principal_kind).toBe("identity");
  expect(f.owner.get(accepted.workflow_id).principal).toBe("alice");
  const duplicate = await f.call(body);
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).work.work_id).toBe(accepted.work_id);
});
it("refuses worker credentials, a bare installation hop, forged evidence and spoofed producer fields", async () => {
  const f = await fixture(),
    delegation = f.issuer.issue(f.request, f.authority),
    body = { request: f.request, delegation };
  expect((await f.call(body, "barry_wk_fixture-worker")).status).toBe(401);
  expect((await f.call({ request: f.request })).status).toBe(400);
  expect(
    (await f.call({ ...body, delegation: { ...delegation, assertion: "not-a-signed-delegation" } }))
      .status,
  ).toBe(403);
  expect(
    (
      await f.call({
        ...body,
        request: {
          ...f.request,
          origin: { ...f.request.origin, trigger: "schedule", occurrence_id: "spoofed" },
        },
      })
    ).status,
  ).toBe(403);
  expect(f.owner.list()).toHaveLength(0);
});
it("rechecks policy on HTTP retries and does not turn transport authentication into caller permission", async () => {
  const f = await fixture(),
    body = { request: f.request, delegation: f.issuer.issue(f.request, f.authority) };
  expect((await f.call(body)).status).toBe(201);
  f.revoke();
  expect((await f.call(body)).status).toBe(403);
  expect(f.owner.list()).toHaveLength(1);
});

it("serves canonical accepted work and operation recovery with authenticated read scopes", async () => {
  const f = await fixture();
  const accepted = (await (await f.call({ request: f.request, delegation: f.issuer.issue(f.request, f.authority) })).json()).work;
  const actor = (principal: string, path: string) => ({ "x-workflow-actor": workflowActorSigner({ identity: principal, bags: [], bound: null, allowedToolIds: ["workflows:get", "workflows:list"] }, "work-read-fixture-actor-key-longer-than-32-bytes")(path) });
  const listPath = "/api/v2/work?states=queued&limit=1";
  const list = await (await f.read(listPath, actor("alice", listPath))).json();
  expect(list.total).toBe(1);
  expect(list.items[0].work_id).toBe(accepted.work_id);
  expect(list.items[0].allowed_actions).toEqual(["inspect"]);
  expect(list.items[0]).not.toHaveProperty("plan");
  expect(list.items[0]).not.toHaveProperty("inputs");
  const detail = `/api/v2/work/${accepted.work_id}`;
  expect((await f.read(detail, actor("alice", detail))).status).toBe(200);
  expect((await f.read(`${detail}/result`, actor("alice", `${detail}/result`))).status).toBe(403);
  expect((await f.read(detail, actor("other", detail))).status).toBe(404);
  expect((await (await f.read(listPath, actor("other", listPath))).json()).total).toBe(0);
  expect((await f.read(detail, { Authorization: "" })).status).toBe(401);
  expect((await f.read(detail, actor("startOnly", detail))).status).toBe(403);
  const lookup = `/api/v2/work/operations?key=${f.request.idempotency_key}&session=session`;
  expect((await (await f.read(lookup, actor("alice", lookup))).json()).work_id).toBe(accepted.work_id);
  expect((await f.read(lookup, actor("other", lookup))).status).toBe(404);
  expect((await f.read(detail, { Authorization: "Bearer barry_wk_fixture-worker" })).status).toBe(401);
  expect((await f.read("/api/v2/work?identity_id=other" )).status).toBe(400);
  expect((await f.read("/api/v2/work?states=invented")).status).toBe(400);
  f.revoke();
  expect((await f.read(detail, actor("alice", detail))).status).toBe(403);
});

it("serves payload-authorized result and revision-bound stop with replayable HTTP acknowledgement", async () => {
  const f = await fixture(true);
  const accepted = (await (await f.call({ request: f.request, delegation: f.issuer.issue(f.request, f.authority) })).json()).work;
  const signer = (principal: string) => workflowActorSigner({ identity: principal, bags: [], bound: null, allowedToolIds: ["workflows:get", "workflows:cancel"] }, "work-read-fixture-actor-key-longer-than-32-bytes");
  const resultPath = `/api/v2/work/${accepted.work_id}/result`, stopPath = `/api/v2/work/${accepted.work_id}/stop`;
  const read = (principal: string) => f.read(resultPath, { "x-workflow-actor": signer(principal)(resultPath) });
  expect((await (await read("alice")).json()).status).toBe("pending");
  expect((await read("other")).status).toBe(404);
  const request = { request_id: "fc31316b-0a3c-43f0-a46c-16032856edaf", expected_revision: accepted.revision };
  expect((await f.write(stopPath, request, signer("other")(stopPath, request))).status).toBe(404);
  f.beginDrain();
  const response = await f.write(stopPath, request, signer("alice")(stopPath, request));
  expect(response.status).toBe(200); const ack = await response.json();
  expect(ack.stop_requested).toBe(true);
  expect(await (await f.write(stopPath, request, signer("alice")(stopPath, request))).json()).toEqual(ack);
  const changed = { ...request, expected_revision: ack.applied_revision };
  expect((await f.write(stopPath, changed, signer("alice")(stopPath, changed))).status).toBe(409);
  expect((await (await read("alice")).json()).outcome).toMatchObject({ ok: false, error: { code: "Cancelled" } });
  f.revoke(); expect((await f.write(stopPath, request, signer("alice")(stopPath, request))).status).toBe(403);
});


it("reviews and applies verified late execution over operator HTTP with immutable replay and audit", async () => {
  const f = await fixture(true), { SqliteDatabase } = await import("@barry-rocks/sdk/internal/stores");
  const accepted = (await (await f.call({ request: f.request, delegation: f.issuer.issue(f.request, f.authority) })).json()).work;
  await f.owner.pump();
  f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.artifact.digest }, capacity: 1 }, {
    version: 2, installation: "owner", boot_identity: "fixture-boot", observed_at: Date.now() - 1, expires_at: Date.now() + 15000,
    executors: ["process"], runtimes: {}, workspaces: [], containment: "portable", features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects"],
  });
  const task = f.owner.claimWork("owner", "http-late-work")!;
  expect(task).not.toBeNull();
  task.work = f.owner.beginWork("owner", task.token); task.deadline = task.work.deadline;
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, task.work![key as keyof typeof task.work]]))), journal = new ExecutorJournal({ path: join(f.root, "executor.db"), installation: "owner", artifacts: f.artifacts });
  cleanup.push(() => journal.close()); journal.start(task.work);
  expect(f.owner.assertWorkEffect("owner", task.token)).toBe(true);
  const claimed = journal.claimStage(binding, "execution"); f.owner.observeWork("owner", task.token, claimed.observation);
  const value = await new ProcessExecutor().activity(f.artifact)(task.input, { ...task, signal: new AbortController().signal });
  const output = f.artifacts.stage(Buffer.from(JSON.stringify(value)), { purpose: "output", owner_identity: f.authority.namespace.identity_id, media_type: "application/json" });
  journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), attempt_id: task.token,
    state: "passed", started_at: claimed.observation.observed_at, completed_at: Date.now(), result: output }, "ceased");
  const unsigned = { ...binding, receipt_ref: journal.newReceiptRef(), revision: journal.inspect(binding)!.revision + 1, committed_at: Date.now(), physical_state: "ceased" as const,
    effect_certainty: "known" as const, outcome: "complete" as const, stages: journal.stageReceipts(binding), output, summary: "Actual isolated retained result", validation: "skipped" as const, validation_failures: null };
  const receipt = journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  const db = new SqliteDatabase(join(f.root, "owner.db"));
  try { db.prepare("UPDATE workflow_commands SET lease_until=0 WHERE id=?").run(task.activityId); } finally { db.close(); }
  f.owner.tick(); expect(f.owner.completeWorkReceipt("owner", task.token, receipt)).toBe("stale");
  const path = `/api/v2/work/${accepted.work_id}/reconciliation`;
  const evidence = await (await f.read(path)).json();
  expect(evidence.receipts).toHaveLength(1); expect(evidence.receipts[0]).toMatchObject({ attempt_id: task.token, receipt_digest: receipt.receipt_digest, outcome: "complete" });
  expect(evidence.receipts[0]).not.toHaveProperty("value"); expect(evidence.audit).toEqual([]);
  expect((await f.read(path, { Authorization: "Bearer barry_wk_fixture-worker" })).status).toBe(401);
  expect((await f.read(path, { Authorization: "" })).status).toBe(401);
  const body = { request_id: "c7e6eb20-d9cf-4d76-8b5c-6b54a88931c0", expected_revision: evidence.revision, attempt_id: task.token, receipt_digest: receipt.receipt_digest,
    reason: "Reviewed original isolated execution and retained result.", residual_risk: "No main relaunch; original known effects retained." };
  const signer = workflowActorSigner({ identity: "alice", bags: [], bound: null, allowedToolIds: ["workflows:get", "workflows:resume"] }, "work-read-fixture-actor-key-longer-than-32-bytes");
  expect((await (await f.read(path, { "x-workflow-actor": signer(path) })).json()).message).toMatch(/local operator/);
  expect((await (await f.write(path, body, signer(path, body))).json()).message).toMatch(/local operator/);
  expect((await f.write(path, { ...body, actor: "forged" })).status).toBe(400);
  expect((await f.write(path, { ...body, expected_revision: evidence.revision - 1 })).status).toBe(409);
  expect((await f.write(path, { ...body, receipt_digest: "f".repeat(64) })).status).toBe(409);
  const response = await f.write(path, body); expect(response.status).toBe(200); const ack = await response.json();
  expect(await (await f.write(path, body)).json()).toEqual(ack);
  expect((await f.write(path, { ...body, reason: "Changed intent" })).status).toBe(409);
  await f.owner.pump(); expect(f.owner.get(accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" });
  const reviewed = await (await f.read(path)).json(); expect(reviewed.audit).toHaveLength(1);
  expect(reviewed.audit[0].evidence).toMatchObject({ actor: "local-operator", reason: body.reason, residualRisk: body.residual_risk });
  expect(journal.claimStage(binding, "execution").launch).toBe(false);
  f.revoke(); expect((await f.read(path)).status).toBe(403); expect((await f.write(path, body)).status).toBe(403);
});
