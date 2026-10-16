import { readFileSync, mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowOwner } from "./workflow-owner.js";
import { ProcessExecutor } from "./executor.js";
import { inspectArtifact, artifactAbi } from "./artifacts.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkflowError } from "./errors.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { SQLInputValue } from "node:sqlite";
import type { WorkAuthority } from "./work-authority.js";
import type { WorkSubmission } from "./work-contracts.js";
import { WorkProjectionReplica, workProjectionDigest } from "./work-projection.js";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import { executionBindingSchema, projectWorkState, logicalStageEffectKey } from "./work-contracts.js";
import { dispatchWorkerRequest, connectWorkOwnerV3 } from "./protocol.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { Json } from "./types.js";
import { WorkReadService, backfillWorkIndex } from "./work-read.js";
import { WorkResourceBroker, type WorkResourceRequest } from "./work-resource-broker.js";
import { WorkControlService } from "./work-control.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sourcePath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
async function fixture(clock?: () => number, workflowSource = sourcePath) {
  const root = mkdtempSync(join(tmpdir(), "work-admission-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const mutableSource = join(root, "mutable-workflow.mjs");
  writeFileSync(mutableSource, readFileSync(workflowSource));
  const workflow = inspectArtifact(mutableSource, "echo", "1");
  const source = artifacts.stage(readFileSync(workflowSource), {
    owner_identity: null,
    purpose: "source",
    media_type: "text/javascript",
  });
  const path = join(root, "owner.db");
  const executor = new ProcessExecutor();
  const broker = new WorkResourceBroker({ path: join(root, "resource.db"), broker: "local-host", limits: { local: { kind: "host" } }, now: clock });
  cleanup.push(() => broker.close());
  const workResources = { host: () => ({ broker: "local-host", resource: "local" }), brokers: new Map([["local-host", broker]]) };
  let dispatchDenied = false, dispatchCeiling: WorkAuthority["caller_ceiling"] | undefined;
  const owner = new WorkflowOwner({
    id: "owner",
    path,
    artifacts: [workflow],
    activityArtifacts: { echo: workflow.digest },
    executor,
    workArtifacts: artifacts,
    now: clock,
    workResources,
    authorizeWork: () => dispatchDenied ? null : dispatchCeiling ?? scope,
  });
  cleanup.push(async () => {
    await owner.drain();
    owner.close();
  });
  const scope = await approveWorkflowBounds({
    identity: "alice",
    traitNames: [],
    traits: {},
    tools: [],
    bounds: [{ files: { allow: [] }, nodes: { allow: ["local"] } }],
    boundByName: async () => undefined,
  });
  const request: WorkSubmission = {
    version: 2,
    request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05437",
    idempotency_key: "invoke",
    authority_ref: "issuer-reference",
    definition: { kind: "workflow", reference: "echo", version: "1" },
    inputs: "hello",
    origin: { entry_point: "workflow-run", trigger: "invocation", caller_session_id: "session" },
  };
  const authority: WorkAuthority = {
    namespace: {
      installation: "owner",
      principal_kind: "identity",
      principal_id: "alice",
      identity_id: "alice",
      caller_session_id: "session",
    },
    caller_ceiling: scope,
    origin: request.origin,
    run_identity: "alice",
  };
  let resolves = 0,
    revoked = false,
    title = "First definition";
  const resolution = (input = request, authenticated = authority): WorkResolution => {
    const grant = {
      version: 2 as const,
      grant_ref: "work-grant",
      revision: 1,
      namespace: authenticated.namespace,
      authorizer: authenticated.namespace.principal_id,
      created_by: authenticated.namespace.principal_id,
      approved_at: 100,
      original_caller_ceiling: authenticated.caller_ceiling,
      effective_scope: authenticated.caller_ceiling,
      definition_bounds_digest: boundFingerprint(authenticated.caller_ceiling.bound),
      policy_revision: "policy-1",
    };
    return {
      title,
      grant,
      workflow_input: input.inputs,
      plan: {
        version: 2,
        definition: input.definition,
        workflow: {
          type: "echo",
          version: "1",
          artifact_digest: workflow.digest,
          runtime_abi: artifactAbi,
          input_digest: boundFingerprint(input.inputs),
        },
        source_closure: [source],
        grant_ref: grant.grant_ref,
        grant_revision: 1,
        grant_digest: boundFingerprint(grant),
        executor_generation: "work-v2",
        execution_profile: "portable",
        effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 60000 },
        resources: {
          executor: "process",
          lane:
            authenticated.origin.trigger === "schedule"
              ? "scheduled"
              : authenticated.origin.trigger === "internal"
                ? "internal"
                : "unscheduled",
          logical_reservation: "owner-will-assign",
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
  };
  const service = (
    authenticated = authority,
    resolve = async (input: WorkSubmission, current: WorkAuthority) => {
      resolves++;
      return resolution(input, current);
    },
  ) =>
    new WorkAdmissionService({
      owner,
      authenticate: async (_input: WorkSubmission, credentials: string) => {
        if (credentials !== "alice" || revoked)
          throw new WorkflowError("Forbidden", "Not authorized.", 403);
        return authenticated;
      },
      resolve,
    });
  const inspect = () => new SqliteDatabase(path);
  const counts = () => {
    const db = inspect();
    try {
      return Object.fromEntries(
        [
          "workflow_runs",
          "workflow_grants",
          "workflow_work_admissions",
          "workflow_work_grants",
          "workflow_work_sources",
          "workflow_work_reservations",
          "workflow_work_outbox",
        ].map((table) => [table, db.prepare(`SELECT count(*) count FROM ${table}`).get()?.count]),
      );
    } finally {
      db.close();
    }
  };
  return {
    owner,
    executor,
    broker,
    workResources,
    artifacts,
    path,
    workflow,
    mutableSource,
    request,
    authority,
    resolution,
    service,
    counts,
    inspect,
    denyEffects: () => { dispatchDenied = true; },
    changeEffectScope: (value: WorkAuthority["caller_ceiling"]) => { dispatchCeiling = value; },
    features: () => ({ version: 2 as const, installation: "owner", boot_identity: "boot", observed_at: Date.now() - 1, expires_at: Date.now() + 15000,
      executors: ["process", "structured-agent", "model", "scoped-tool"] as const,
      features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects"] as const,
      runtimes: {}, workspaces: [], containment: "portable" as const }),
    resolves: () => resolves,
    revoke: () => {
      revoked = true;
    },
    changeCatalog: () => {
      title = "Changed definition";
    },
  };
}
it("commits workflow, grant, retained sources, reservation and outbox together before evaluation", async () => {
  const f = await fixture();
  const accepted = await f.service().submit(f.request, "alice");
  expect(accepted.work_id).toMatch(/^work_/);
  expect(accepted.workflow_id).toMatch(/^awf_/);
  expect(accepted.action_id).toBeNull();
  expect(accepted.job_run_id).toBeNull();
  expect(accepted.plan.resources.host_reservation).toBeNull();
  expect(f.counts()).toEqual({
    workflow_runs: 1,
    workflow_grants: 1,
    workflow_work_admissions: 1,
    workflow_work_grants: 1,
    workflow_work_sources: 1,
    workflow_work_reservations: 1,
    workflow_work_outbox: 1,
  });
  expect(f.owner.inspect(accepted.workflow_id).commands).toHaveLength(0);
  await f.owner.pump();
  expect(f.owner.get(accepted.workflow_id).error).toBeNull();
  expect(f.owner.inspect(accepted.workflow_id).commands).toHaveLength(1);
  expect(f.owner.workByKey(f.authority.namespace, f.request.idempotency_key)).toEqual(accepted);
});
it("looks up accepted intent before resolving edited catalogs or allocating another slot", async () => {
  const f = await fixture(),
    service = f.service();
  const accepted = await service.submit(f.request, "alice");
  f.changeCatalog();
  const duplicate = await service.submit(
    { ...f.request, request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438" },
    "alice",
  );
  expect(duplicate).toEqual(accepted);
  expect(f.resolves()).toBe(1);
  await expect(service.submit({ ...f.request, inputs: "changed" }, "alice")).rejects.toMatchObject({
    code: "IdempotencyConflict",
    status: 409,
  });
  expect(f.resolves()).toBe(1);
  expect(f.counts().workflow_work_reservations).toBe(1);
});
it("converges concurrent service instances and refuses conflicting intent without effects", async () => {
  const f = await fixture();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => f.service().submit(f.request, "alice")),
  );
  expect(new Set(responses.map((row) => row.workflow_id)).size).toBe(1);
  expect(f.counts().workflow_runs).toBe(1);
  expect(f.counts().workflow_work_outbox).toBe(1);
  expect(f.owner.inspect(responses[0].workflow_id).commands).toHaveLength(0);
});
it("rechecks policy before duplicate lookup and never reveals another namespace's key", async () => {
  const f = await fixture();
  await f.service().submit(f.request, "alice");
  const lookup = vi.spyOn(f.owner, "workByKey");
  f.revoke();
  await expect(f.service().submit(f.request, "alice")).rejects.toMatchObject({ status: 403 });
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockRestore();
  expect(
    f.owner.workByKey(
      { ...f.authority.namespace, principal_id: "other" },
      f.request.idempotency_key,
    ),
  ).toBeNull();
});
it("rolls back every canonical record if publication intent cannot be committed", async () => {
  const f = await fixture(),
    db = f.inspect();
  db.exec(
    "CREATE TRIGGER fault BEFORE INSERT ON workflow_work_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END",
  );
  db.close();
  await expect(f.service().submit(f.request, "alice")).rejects.toThrow("outbox unavailable");
  expect(Object.values(f.counts())).toEqual([0, 0, 0, 0, 0, 0, 0]);
  await f.owner.pump();
  expect(f.owner.list()).toHaveLength(0);
});
it.each([true, false])(
  "recovers an ambiguous owner commit with the same key (commit applied: %s)",
  async (committed) => {
    const f = await fixture(),
      service = f.service();
    const store = Reflect.get(f.owner, "store") as WorkflowStore;
    const connection = Reflect.get(store, "db") as SqliteDatabase,
      exec = connection.exec.bind(connection);
    const spy = vi.spyOn(connection, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (committed) exec(sql);
        throw new Error("commit acknowledgement lost");
      }
      return exec(sql);
    });
    await expect(service.submit(f.request, "alice")).rejects.toThrow("commit acknowledgement lost");
    spy.mockRestore();
    const accepted = await service.submit(f.request, "alice");
    expect(f.counts().workflow_runs).toBe(1);
    expect(f.owner.get(accepted.workflow_id).status).toBe("running");
    expect(f.resolves()).toBe(committed ? 1 : 2);
    expect(Reflect.get(store, "db")).not.toBe(connection);
  },
);
it("refuses corrupted retained bytes before acceptance", async () => {
  const f = await fixture();
  const result = f.resolution();
  const retained = f.artifacts.path(result.plan.source_closure[0]);
  writeFileSync(retained, "changed");
  await expect(f.service().submit(f.request, "alice")).rejects.toMatchObject({
    code: "ArtifactMismatch",
  });
  expect(f.counts().workflow_runs).toBe(0);
});
it("refuses changed authority after asynchronous resolution and unauthorized schedule provenance", async () => {
  const f = await fixture();
  const service = f.service(f.authority, async (request) => {
    f.revoke();
    return f.resolution(request);
  });
  await expect(service.submit(f.request, "alice")).rejects.toMatchObject({ status: 403 });
  expect(f.counts().workflow_runs).toBe(0);
  const other = await fixture();
  const scheduled = {
    ...other.request,
    origin: { ...other.request.origin, trigger: "schedule" as const, occurrence_id: "spoofed" },
  };
  await expect(other.service().submit(scheduled, "alice")).rejects.toMatchObject({
    code: "InvalidOrigin",
  });
});
it("preserves four scheduled agent slots and caller limits under unscheduled saturation", async () => {
  const f = await fixture();
  const admissions = [];
  const agent = (request: WorkSubmission, authority: WorkAuthority) => {
    const result = f.resolution(request, authority);
    result.plan.resources.executor = "agent";
    return Promise.resolve(result);
  };
  for (let caller = 0; caller < 4; caller++) {
    const origin = { ...f.request.origin, caller_session_id: `session-${caller}` };
    const authority = {
      ...f.authority,
      origin,
      namespace: { ...f.authority.namespace, caller_session_id: origin.caller_session_id },
    };
    const service = f.service(authority, agent);
    for (let index = 0; index < 4; index++)
      admissions.push(
        await service.submit({ ...f.request, origin, idempotency_key: `agent-${index}` }, "alice"),
      );
    await expect(
      service.submit({ ...f.request, origin, idempotency_key: "fifth" }, "alice"),
    ).rejects.toMatchObject({ code: "executor_busy" });
  }
  const origin = {
    entry_point: "scheduler",
    trigger: "schedule" as const,
    producer_ref: "schedule",
    occurrence_id: "due",
  };
  const authority = {
    ...f.authority,
    origin,
    namespace: {
      ...f.authority.namespace,
      principal_kind: "service" as const,
      principal_id: "scheduler",
      caller_session_id: null,
    },
  };
  for (let index = 0; index < 4; index++)
    await f
      .service(authority, agent)
      .submit({ ...f.request, origin, idempotency_key: `scheduled-${index}` }, "alice");
  await expect(
    f
      .service(authority, agent)
      .submit({ ...f.request, origin, idempotency_key: "scheduled-fifth" }, "alice"),
  ).rejects.toMatchObject({ code: "executor_busy" });
  f.owner.cancel(admissions[0].workflow_id);
  const firstOrigin = { ...f.request.origin, caller_session_id: "session-0" };
  const firstAuthority = {
    ...f.authority,
    origin: firstOrigin,
    namespace: { ...f.authority.namespace, caller_session_id: firstOrigin.caller_session_id },
  };
  expect(
    (
      await f
        .service(firstAuthority, agent)
        .submit({ ...f.request, origin: firstOrigin, idempotency_key: "replacement" }, "alice")
    ).work_id,
  ).toMatch(/^work_/);
});

it("executes retained coordination bytes after the mutable registration source disappears", async () => {
  const f = await fixture();
  const accepted = await f.service().submit(f.request, "alice");
  rmSync(f.mutableSource);
  await f.owner.pump();
  expect(f.owner.get(accepted.workflow_id).error).toBeNull();
  expect(f.owner.inspect(accepted.workflow_id).commands).toHaveLength(1);
  expect(f.owner.get(accepted.workflow_id).status).toBe("running");
});
it("does not free an agent admission reservation on cancellation until physical settlement is recorded", async () => {
  const f = await fixture();
  const service = f.service(f.authority, async (request) => {
    const resolved = f.resolution(request);
    resolved.plan.resources.executor = "agent";
    return resolved;
  });
  for (let index = 0; index < 4; index++)
    await service.submit({ ...f.request, idempotency_key: `held-${index}` }, "alice");
  await f.owner.pump();
  f.owner.advertiseWork("owner", {
    types: ["echo"],
    artifacts: { echo: f.workflow.digest },
    capacity: 4,
  }, { ...f.features(), executors: [...f.features().executors], features: [...f.features().features] });
  const task = f.owner.claimWork("owner", "known-claim")!;
  expect(task).not.toBeNull();
  task.work = f.owner.beginWork("owner", task.token);
  f.owner.cancel(task.runId);
  await expect(
    service.submit({ ...f.request, idempotency_key: "fifth" }, "alice"),
  ).rejects.toMatchObject({ code: "executor_busy" });
  expect(() => f.owner.settlePhysical("owner", task.token)).toThrow(/receipt/);
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, task.work![key as keyof typeof task.work]])));
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "journal.db"), installation: "owner" }); cleanup.push(() => journal.close());
  journal.cancel(binding); const observation = journal.inspect(binding)!;
  const unsigned = { ...binding, receipt_ref: "cancel-receipt", revision: observation.revision + 1, committed_at: Date.now(), physical_state: "not-started" as const,
    effect_certainty: "not-started" as const, outcome: "cancelled" as const, stages: [], output: null, summary: "cancelled before launch", validation: "skipped" as const, validation_failures: null };
  f.owner.completeWorkReceipt("owner", task.token, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  expect(
    (await service.submit({ ...f.request, idempotency_key: "fifth" }, "alice")).work_id,
  ).toMatch(/^work_/);
});

it("collects only aged unaccepted staging while preserving all accepted source pins", async () => {
  const f = await fixture();
  const orphan = f.artifacts.stage(Buffer.from("orphaned before acceptance"), {
    owner_identity: "alice",
    purpose: "input",
    media_type: "text/plain",
  });
  const pinned = f.artifacts.stage(Buffer.from("accepted data"), {
    owner_identity: "alice",
    purpose: "input",
    media_type: "text/plain",
  });
  const old = new Date(Date.now() - 3 * 86400000);
  [orphan, pinned].forEach((reference) => utimesSync(f.artifacts.path(reference), old, old));
  const service = f.service(f.authority, async (request) => {
    const resolved = f.resolution(request);
    resolved.plan.source_closure.push(pinned);
    return resolved;
  });
  await service.submit(f.request, "alice");
  expect(f.owner.collectWorkStaging()).toBe(1);
  expect(existsSync(f.artifacts.path(orphan))).toBe(false);
  expect(f.artifacts.verify(pinned).toString()).toBe("accepted data");
  expect(() => f.owner.collectWorkStaging(Date.now())).toThrow(/24 hours/);
});
it("resumes a committed collection intent after deletion acknowledgement fails", async () => {
  const f = await fixture();
  const orphan = f.artifacts.stage(Buffer.from("crash-safe orphan"), {
    owner_identity: "alice",
    purpose: "input",
    media_type: "text/plain",
  });
  const old = new Date(Date.now() - 3 * 86400000);
  utimesSync(f.artifacts.path(orphan), old, old);
  const db = f.inspect();
  db.exec(
    "CREATE TRIGGER fault BEFORE DELETE ON workflow_work_artifact_gc BEGIN SELECT RAISE(ABORT,'collection acknowledgement lost'); END",
  );
  try {
    expect(() => f.owner.collectWorkStaging()).toThrow("collection acknowledgement lost");
    expect(existsSync(f.artifacts.path(orphan))).toBe(false);
    expect(db.prepare("SELECT count(*) n FROM workflow_work_artifact_gc").get()?.n).toBe(1);
    db.exec("DROP TRIGGER fault");
    expect(f.owner.collectWorkStaging()).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM workflow_work_artifact_gc").get()?.n).toBe(0);
  } finally {
    db.close();
  }
});
it("does not delete a newly restaged inode under an older collection intent", async () => {
  const f = await fixture();
  const reference = f.artifacts.stage(Buffer.from("restage safely"), {
    owner_identity: "alice",
    purpose: "input",
    media_type: "text/plain",
  });
  const path = f.artifacts.path(reference),
    candidate = f.artifacts.candidate(boundFingerprint("alice"), reference.digest)!;
  const db = f.inspect();
  try {
    db.prepare("INSERT INTO workflow_work_artifact_gc VALUES(?,?,?,?)").run(
      candidate.namespace_hash,
      candidate.file,
      "old:inode",
      Date.now() - 2 * 86400000,
    );
  } finally {
    db.close();
  }
  const service = f.service(f.authority, async (request) => {
    const resolved = f.resolution(request);
    resolved.plan.source_closure.push(reference);
    return resolved;
  });
  await expect(service.submit(f.request, "alice")).rejects.toMatchObject({
    code: "ArtifactCollectionPending",
  });
  expect(f.owner.collectWorkStaging()).toBe(0);
  expect(existsSync(path)).toBe(true);
  expect((await service.submit(f.request, "alice")).work_id).toMatch(/^work_/);
});
it("allows currently authorized lookup after start permission is revoked, but refuses new work", async () => {
  const f = await fixture();
  let allowStart = true,
    resolved = 0;
  const service = new WorkAdmissionService({
    owner: f.owner,
    authenticate: async (_request: WorkSubmission, _credentials: string, operation) => {
      if (operation === "admit" && !allowStart)
        throw new WorkflowError("Forbidden", "Start revoked.", 403);
      return f.authority;
    },
    resolve: async (request) => {
      resolved++;
      return f.resolution(request);
    },
  });
  const accepted = await service.submit(f.request, "alice");
  allowStart = false;
  expect(await service.submit(f.request, "alice")).toEqual(accepted);
  await expect(
    service.submit({ ...f.request, idempotency_key: "new-invocation" }, "alice"),
  ).rejects.toMatchObject({ status: 403 });
  expect(resolved).toBe(1);
  expect(f.counts().workflow_runs).toBe(1);
});
it("recovers the same accepted work and full grant after reopening the owner store", async () => {
  const f = await fixture();
  const accepted = await f.service().submit(f.request, "alice");
  await f.owner.drain();
  f.owner.close();
  const restored = new WorkflowOwner({
    id: "owner",
    path: f.path,
    artifacts: [{ ...f.workflow, path: f.artifacts.path(accepted.plan.source_closure[0]) }],
    activityArtifacts: { echo: f.workflow.digest },
    executor: new ProcessExecutor(),
    workArtifacts: new WorkArtifactStore(f.artifacts.root),
  });
  cleanup.push(async () => {
    await restored.drain();
    restored.close();
  });
  const service = new WorkAdmissionService({
    owner: restored,
    authenticate: async () => f.authority,
    resolve: async () => {
      throw new Error("mutable catalog must not be resolved");
    },
  });
  expect(await service.submit(f.request, undefined)).toEqual(accepted);
  const db = f.inspect();
  try {
    const stored = JSON.parse(
      String(
        db
          .prepare("SELECT evidence FROM workflow_work_grants WHERE run_id=?")
          .get(accepted.workflow_id)?.evidence,
      ),
    );
    expect(stored.original_caller_ceiling).toEqual(f.authority.caller_ceiling);
    expect(
      db
        .prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?")
        .get(accepted.workflow_id)?.state,
    ).toBe("reserved");
  } finally {
    db.close();
  }
});
it("snapshots and restores every retained source/input, and refuses incomplete bundles", async () => {
  const f = await fixture();
  const data = f.artifacts.stage(Buffer.from("retained input across restore"), {
    owner_identity: "alice",
    purpose: "input",
    media_type: "text/plain",
  });
  const accepted = await f
    .service(f.authority, async (request) => {
      const resolved = f.resolution(request);
      resolved.plan.source_closure.push(data);
      return resolved;
    })
    .submit(f.request, "alice");
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const destination = join(dirname(f.path), "snapshot"),
    restored = join(dirname(f.path), "restored");
  const workflow = { ...f.workflow, path: f.artifacts.path(accepted.plan.source_closure[0]) };
  await expect(snapshotWorkflows(f.path, destination, "owner", [workflow])).rejects.toThrow(
    /retained work artifact root/,
  );
  const manifest = await snapshotWorkflows(
    f.path,
    destination,
    "owner",
    [workflow],
    f.artifacts.root,
  );
  expect(manifest.workArtifacts?.entries).toBe(2);
  await f.owner.drain();
  f.owner.close();
  await restoreWorkflows(destination, restored, "owner", true);
  const restoredArtifacts = new WorkArtifactStore(join(restored, "work-artifacts"));
  expect(restoredArtifacts.verify(data).toString()).toBe("retained input across restore");
  writeFileSync(
    join(destination, "work-artifacts", boundFingerprint("alice"), data.digest),
    "tampered",
  );
  await expect(restoreWorkflows(destination, `${restored}-corrupt`, "owner", true)).rejects.toThrow(
    /artifact.*mismatch/,
  );
  expect(existsSync(`${restored}-corrupt`)).toBe(false);
});
it("cannot widen a work item's original ceiling through legacy workflow reauthorization", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const approved = { revision: 2, authorizer: "alice", createdBy: "alice", approvedAt: Date.now(), reason: "Attempted widening", scope, job: { traits: [], identity: "alice", profile: "portable" as const } };
  expect(() => f.owner.reauthorize(accepted.workflow_id, approved, "widen", f.owner.get(accepted.workflow_id).revision, "alice")).toThrow(/widens/);
  const db = f.inspect();
  try {
    expect(() => db.prepare("UPDATE workflow_work_grants SET digest=? WHERE run_id=?").run("f".repeat(64), accepted.workflow_id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE workflow_work_admissions SET request_hash=? WHERE run_id=?").run("f".repeat(64), accepted.workflow_id)).toThrow(/immutable/);
  } finally { db.close(); }
});
it("rechecks an observer's read authority after waiting for a concurrent acceptance", async () => {
  const f = await fixture();
  let release!: () => void, resolving!: () => void, readerRevoked = false;
  const entered = new Promise<void>(resolve => { resolving = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const service = new WorkAdmissionService({ owner: f.owner, authenticate: async (_request: WorkSubmission, credentials: string, operation) => { if (credentials === "reader" && (operation === "admit" || readerRevoked)) throw new WorkflowError("Forbidden", "Reader revoked.", 403); return f.authority; }, resolve: async request => { resolving(); await wait; return f.resolution(request); } });
  const first = service.submit(f.request, "starter"); await entered;
  const observer = service.submit(f.request, "reader");
  await Promise.resolve(); await Promise.resolve();
  readerRevoked = true; release();
  expect((await first).work_id).toMatch(/^work_/);
  await expect(observer).rejects.toMatchObject({ status: 403 });
  expect(f.counts().workflow_runs).toBe(1);
});

it("finds canonical acceptance while the replica is absent, failing or missing its outbox", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.work_id).toBe(accepted.work_id);
  expect(f.owner.workById({ ...f.authority.namespace, identity_id: "other" }, accepted.work_id)).toBeNull();
  await expect(f.owner.publishWorkProjections({ apply: async () => { throw new Error("target unavailable"); } })).rejects.toThrow(/unavailable/);
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.projection.applied_revision).toBe(0);
  const db = f.inspect(); db.prepare("DELETE FROM workflow_work_outbox WHERE run_id=?").run(accepted.workflow_id); db.close();
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.work_id).toBe(accepted.work_id);
});
it("replays a committed projection after a lost target acknowledgement without duplicate rows", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "views.db"), owner: "owner" });
  cleanup.push(() => replica.close());
  await expect(f.owner.publishWorkProjections({ apply: work => { replica.apply(work); throw new Error("lost target acknowledgement"); } })).rejects.toThrow(/acknowledgement/);
  expect(replica.get(f.authority.namespace, accepted.work_id)?.revision).toBe(1);
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.projection.applied_revision).toBe(0);
  expect(await f.owner.publishWorkProjections(replica)).toBe(1);
  expect(await f.owner.publishWorkProjections(replica)).toBe(0);
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.projection.applied_revision).toBe(1);
  const db = new SqliteDatabase(join(dirname(f.path), "views.db"));
  expect(db.prepare("SELECT count(*) n FROM work_views").get()?.n).toBe(1); db.close();
});
it("never overwrites a newer view and refuses same-revision or cross-identity substitution", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const path = join(dirname(f.path), "views.db"), replica = new WorkProjectionReplica({ path, owner: "owner" });
  cleanup.push(() => replica.close());
  const newer = { ...accepted, revision: 2, facts: { ...accepted.facts, phase: "executing" as const, physical: "running" as const }, projection: { desired_revision: 2, applied_revision: 0 } };
  replica.apply(newer); replica.apply(accepted);
  expect(replica.get(f.authority.namespace, accepted.work_id)?.revision).toBe(2);
  expect(() => replica.apply({ ...newer, title: "different same revision" })).toThrow(/different facts/);
  expect(() => replica.apply({ ...newer, revision: 3, namespace: { ...newer.namespace, identity_id: "other" } })).toThrow(/ownership/);
  expect(replica.get({ ...f.authority.namespace, principal_id: "other" }, accepted.work_id)).toBeNull();
  expect(() => new WorkProjectionReplica({ path, owner: "other" })).toThrow(/owner/);
});
it("guards acknowledgement when a newer outbox intent appears during delivery", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice"), db = f.inspect();
  cleanup.push(() => db.close());
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "views.db"), owner: "owner" });
  cleanup.push(() => replica.close());
  const newer = { ...accepted, revision: 2, title: "new state revision", projection: { desired_revision: 2, applied_revision: 0 } };
  expect(await f.owner.publishWorkProjections({ apply: work => {
    const ack = replica.apply(work);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE workflow_work_admissions SET record=? WHERE run_id=?").run(JSON.stringify(newer), accepted.workflow_id);
    db.prepare("UPDATE workflow_work_outbox SET desired_revision=2,body=? WHERE run_id=?").run(JSON.stringify(newer), accepted.workflow_id);
    db.exec("COMMIT");
    return ack;
  } })).toBe(0);
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.projection).toEqual({ desired_revision: 2, applied_revision: 0 });
  expect(await f.owner.publishWorkProjections(replica)).toBe(1);
  expect(replica.get(f.authority.namespace, accepted.work_id)?.title).toBe("new state revision");
});
it("refuses an acknowledgement for another payload and ignores delivery metadata in semantic digests", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  expect(workProjectionDigest({ ...accepted, projection: { desired_revision: 1, applied_revision: 1 } })).toBe(workProjectionDigest(accepted));
  await expect(f.owner.publishWorkProjections({ apply: work => ({ work_id: work.work_id, revision: work.revision, digest: "f".repeat(64) }) })).rejects.toMatchObject({ code: "ProjectionAcknowledgementInvalid" });
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.projection.applied_revision).toBe(0);
});
it.each([true, false])("recovers ambiguous replica COMMIT (applied: %s) with the same view", async applied => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "views.db"), owner: "owner" }); cleanup.push(() => replica.close());
  const db = Reflect.get(replica, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost replica commit acknowledgement"); } return original(sql);
  });
  await expect(f.owner.publishWorkProjections(replica)).rejects.toThrow(/acknowledgement/);
  expect(replica.get(f.authority.namespace, accepted.work_id)?.revision ?? null).toBe(applied ? 1 : null);
  expect(await f.owner.publishWorkProjections(replica)).toBe(1);
});
it.each([true, false])("recovers owner projection-ack COMMIT ambiguity (applied: %s)", async applied => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "views.db"), owner: "owner" }); cleanup.push(() => replica.close());
  const store = Reflect.get(f.owner, "store") as WorkflowStore, db = Reflect.get(store, "db") as SqliteDatabase, original = db.exec.bind(db);
  let delivered = false, faulted = false;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql === "COMMIT" && delivered && !faulted) { faulted = true; if (applied) original(sql); throw new Error("lost owner projection acknowledgement"); } return original(sql);
  });
  await expect(f.owner.publishWorkProjections({ apply: work => { const ack = replica.apply(work); delivered = true; return ack; } })).rejects.toThrow(/acknowledgement/);
  expect(f.owner.workByKey(f.authority.namespace, f.request.idempotency_key)?.projection.applied_revision).toBe(applied ? 1 : 0);
  expect(await f.owner.publishWorkProjections(replica)).toBe(applied ? 0 : 1);
  expect(replica.get(f.authority.namespace, accepted.work_id)?.revision).toBe(1);
});
it("refuses synchronous common-work admission before a definition can perform effects", async () => {
  const f = await fixture(); let effects = 0;
  const sync = new WorkflowOwner({ id: "owner", path: join(dirname(f.path), "sync.db"), workArtifacts: f.artifacts,
    definitions: [{ type: "echo", version: "1", *run() { effects++; yield { kind: "timer", delayMs: 1 }; return null; } }] });
  cleanup.push(() => sync.close());
  expect(() => sync.admitWork(f.request, f.authority, f.resolution())).toThrow(/verified artifact evaluator/);
  expect(effects).toBe(0);
  const db = new SqliteDatabase(join(dirname(f.path), "sync.db"));
  expect(db.prepare("SELECT count(*) n FROM workflow_runs").get()?.n).toBe(0); db.close();
});
it("keeps existing common-work lookup but blocks synchronous replay after an evaluator is removed", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  await f.owner.drain(); f.owner.close(); let effects = 0;
  const sync = new WorkflowOwner({ id: "owner", path: f.path, workArtifacts: f.artifacts,
    definitions: [{ type: "echo", version: "1", *run() { effects++; yield { kind: "timer", delayMs: 1 }; return null; } }] });
  cleanup.push(() => sync.close());
  expect(sync.admitWork(f.request, f.authority, f.resolution()).work_id).toBe(accepted.work_id);
  sync.tick();
  expect(effects).toBe(0);
  expect(sync.get(accepted.workflow_id).status).toBe("blocked");
});

async function executingWork(existing?: Awaited<ReturnType<typeof fixture>>, key?: string) {
  const f = existing ?? await fixture(), accepted = await f.service().submit(key ? { ...f.request, idempotency_key: key } : f.request, "alice");
  await f.owner.pump();
  const features = f.features();
  f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...features, executors: [...features.executors], features: [...features.features] });
  // A bounded fair scan may need to wrap past the previously completed run.
  let claimed = f.owner.claimWork("owner", key ? `work-claim-${key}` : "work-claim");
  for (let page = 0; key && !claimed && page < 4; page++) claimed = f.owner.claimWork("owner", `work-claim-${key}-${page}`);
  expect(claimed).not.toBeNull();
  const task = claimed!;
  const request = f.owner.beginWork("owner", task.token);
  task.work = request; task.deadline = request.deadline; task.timeoutMs = Math.max(1, request.deadline - Date.now());
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, request[key as keyof typeof request]])));
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "executor.db"), installation: "owner", artifacts: f.artifacts });
  cleanup.push(() => journal.close());
  journal.start(request);
  const receipt = async (spool?: (value: Json) => { bytes: Buffer; media: string }) => {
    expect(f.owner.assertWorkEffect("owner", task.token)).toBe(true);
    const claim = journal.claimStage(binding, "execution");
    expect(claim.launch).toBe(true);
    f.owner.observeWork("owner", task.token, claim.observation);
    const value = await f.executor.activity(f.workflow)(task.input, { ...task, signal: new AbortController().signal });
    const encoded = spool?.(value) ?? { bytes: Buffer.from(JSON.stringify(value)), media: "application/json" };
    const output = f.artifacts.stage(encoded.bytes, { owner_identity: f.authority.namespace.identity_id, purpose: "output", media_type: encoded.media });
    journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"),
      attempt_id: task.token, state: "passed", started_at: claim.observation.observed_at, completed_at: Date.now(), result: output }, "ceased");
    const unsigned = { ...binding, receipt_ref: journal.newReceiptRef(), revision: journal.inspect(binding)!.revision + 1, committed_at: Date.now(),
      physical_state: "ceased" as const, effect_certainty: "known" as const, outcome: "complete" as const, stages: journal.stageReceipts(binding), output,
      summary: "isolated echo result", validation: "skipped" as const, validation_failures: null };
    return journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  };
  return { ...f, accepted, task, binding, journal, receipt };
}
it("delivers a real isolated activity through durable journal, result spool, owner receipt and live projection", async () => {
  const f = await executingWork();
  expect(f.owner.claim("owner", "legacy-claim")).toBeNull();
  expect(() => f.owner.complete("owner", f.task.token, { ok: true, value: "forged" })).toThrow(/receipt/);
  const receipt = await f.receipt();
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("accepted");
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
  await f.owner.pump();
  expect(f.owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("completed");
  expect(work.receipt_ref).toBe(receipt.receipt_ref);
  expect(work.first_started_at).not.toBeNull();
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "replica.db"), owner: "owner" }); cleanup.push(() => replica.close());
  await f.owner.publishWorkProjections(replica);
  expect(projectWorkState(replica.get(f.authority.namespace, work.work_id)!.facts).state).toBe("completed");
});
it("refuses receipt binding/digest/identity substitutions without settling the physical attempt", async () => {
  const f = await executingWork(), receipt = await f.receipt();
  const substitutions = [{ ...receipt, receipt_digest: "f".repeat(64) }, { ...receipt, attempt_id: "other" },
    { ...receipt, deadline: receipt.deadline + 1 }, { ...receipt, output: { ...receipt.output!, owner_identity: "other" } }];
  for (const candidate of substitutions) expect(() => f.owner.completeWorkReceipt("owner", f.task.token, candidate)).toThrow();
  expect(() => f.owner.completeWorkReceipt("other", f.task.token, receipt)).toThrow(/binding/);
  const db = f.inspect();
  expect(db.prepare("SELECT physical_state FROM workflow_attempts WHERE token=?").get(f.task.token)?.physical_state).toBe("running");
  expect(db.prepare("SELECT receipt FROM workflow_work_executions WHERE token=?").get(f.task.token)?.receipt).toBeNull(); db.close();
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("accepted");
});
it("refuses new completion evidence whose effectful stage finished after the original deadline", async () => {
  const f = await executingWork(), receipt = await f.receipt();
  const { receipt_digest: _digest, ...unsigned } = receipt;
  unsigned.stages = unsigned.stages.map(stage => ({ ...stage, completed_at: receipt.deadline + 1 }));
  expect(() => f.owner.completeWorkReceipt("owner", f.task.token, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) })).toThrow(/original execution deadline/);
  const inspect = f.inspect(); expect(inspect.prepare("SELECT receipt FROM workflow_work_executions WHERE token=?").get(f.task.token)?.receipt).toBeNull(); inspect.close();
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("accepted");
});
it.each([true, false])("recovers owner receipt COMMIT ambiguity without another activity launch (applied: %s)", async applied => {
  const f = await executingWork(), receipt = await f.receipt(), store = Reflect.get(f.owner, "store") as WorkflowStore;
  const db = Reflect.get(store, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost owner receipt acknowledgement"); } return original(sql);
  });
  expect(() => f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toThrow(/acknowledgement/);
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe(applied ? "alreadyAccepted" : "accepted");
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
  expect(f.owner.claimWork("owner", "retry-claim")).toBeNull();
});
it("rechecks full current policy at the privileged effect boundary", async () => {
  const f = await executingWork(); f.denyEffects();
  expect(f.owner.heartbeat("owner", f.task.token)).toBe(false);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/Current full execution policy/);
  expect(f.journal.inspect(f.binding)?.effect_certainty).toBe("not-started");
});
it("refuses a narrowed current node ceiling or changed execution identity without retiring the worker credential", async () => {
  const f = await executingWork();
  const denied = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [],
    bounds: [{ files: { allow: [] }, nodes: { allow: [] } }], boundByName: async () => undefined });
  f.changeEffectScope(denied);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/no longer permits/);
  try { f.owner.assertWorkEffect("owner", f.task.token); } catch (error) { expect((error as WorkflowError).status).toBe(409); }
  const other = await approveWorkflowBounds({ identity: "bob", traitNames: [], traits: {}, tools: [],
    bounds: [{ files: { allow: [] }, nodes: { allow: ["local"] } }], boundByName: async () => undefined });
  f.changeEffectScope(other);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/another execution identity/);
  f.changeEffectScope(f.authority.caller_ceiling);
  expect(f.owner.assertWorkEffect("owner", f.task.token)).toBe(true);
});
it("does not let a protocol-v2 worker receive common work, and fences protocol-v3 sessions", async () => {
  const f = await executingWork();
  const hello = dispatchWorkerRequest(f.owner, "owner", { version: 3, operation: "hello", session: "session-v3" }) as { epoch: string };
  expect(dispatchWorkerRequest(f.owner, "owner", { version: 3, operation: "effect", session: "session-v3", epoch: hello.epoch, token: f.task.token })).toBe(true);
  expect(() => dispatchWorkerRequest(f.owner, "other", { version: 3, operation: "effect", session: "session-v3", epoch: hello.epoch, token: f.task.token })).toThrow();
  expect(() => dispatchWorkerRequest(f.owner, "owner", { version: 3, operation: "effect", session: "session-v3", epoch: "stale", token: f.task.token })).toThrow();
});
it("retains lease-loss uncertainty and late known output without dispatching another attempt", async () => {
  const f = await executingWork(), receipt = await f.receipt(), db = f.inspect();
  db.prepare("UPDATE workflow_commands SET lease_until=0 WHERE id=?").run(f.task.activityId); db.close();
  f.owner.tick();
  let work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("needs-attention");
  expect(work.reason?.code).toBe("ExecutionUncertain");
  expect(f.owner.claimWork("owner", "after-expiry")).toBeNull();
  expect(() => f.owner.resume(f.task.runId)).toThrow(/reconciliation/);
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("stale");
  work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(work.facts.physical).toBe("ceased");
  expect(work.receipt_ref).toBe(receipt.receipt_ref);
  expect(work.reason?.code).toBe("LateExecutionEvidence");
  expect(projectWorkState(work.facts).state).toBe("needs-attention");
  expect(() => f.owner.resume(f.task.runId)).toThrow(/reconciliation/);
});
it("keeps original execution deadlines and recovers the same receipt after owner restart", async () => {
  const f = await executingWork(), receipt = await f.receipt(), deadline = f.owner.workById(f.authority.namespace, f.accepted.work_id)!.execution_deadline;
  await f.owner.drain(); f.owner.close();
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest },
    executor: new ProcessExecutor(), workArtifacts: f.artifacts, workResources: f.workResources, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("accepted");
  expect(owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
  expect(owner.workById(f.authority.namespace, f.accepted.work_id)?.execution_deadline).toBe(deadline);
  await owner.pump();
  expect(owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
});
it("uses the versioned client over HTTP and retries a lost completion response without re-execution", async () => {
  const f = await executingWork(); let drop = true;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== "Bearer fixture-worker") { response.writeHead(401).end(); return; }
      const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(parts).toString());
      const result = dispatchWorkerRequest(f.owner, "owner", message);
      if (message.operation === "complete" && drop) { drop = false; response.destroy(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch { response.writeHead(409).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const client = connectWorkOwnerV3("owner", async message => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as {port: number}).port}`, { method: "POST", headers: { Authorization: "Bearer fixture-worker" }, body: JSON.stringify(message) });
    if (!response.ok) throw new Error(`worker transport ${response.status}`);
    return response.json();
  });
  const features = f.features();
  await client.advertise({ types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 }, { ...features, features: [...features.features], executors: [...features.executors] });
  const redelivery = await client.claim("work-claim");
  expect(redelivery?.work?.launch_authorized).toBe(false);
  expect(await client.begin(f.task.token)).toEqual(f.task.work);
  expect(await client.effect(f.task.token)).toBe(true);
  const receipt = await f.receipt();
  await expect(client.complete(f.task.token, receipt)).rejects.toThrow();
  expect(await client.complete(f.task.token, receipt)).toEqual({ status: "alreadyAccepted" });
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
  expect((await client.inspect(f.task.token)).observation.receipt_ref).toBe(receipt.receipt_ref);
  const db = f.inspect();
  expect(db.prepare("SELECT count(*) n FROM workflow_work_sources WHERE run_id=? AND purpose='output'").get(f.task.runId)?.n).toBe(1); db.close();
});
it("snapshots and restores the owner receipt and its verified result dependencies without rerunning work", async () => {
  const f = await executingWork(), receipt = await f.receipt();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(dirname(f.path), "receipt-snapshot"), restored = join(dirname(f.path), "receipt-restore");
  const manifest = await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root);
  expect(manifest.workArtifacts!.entries).toBeGreaterThanOrEqual(2);
  await f.owner.drain(); f.owner.close();
  await restoreWorkflows(snapshot, restored, "owner", true);
  const recovered = new SqliteDatabase(join(restored, "workflows.db"));
  const row = recovered.prepare("SELECT receipt,receipt_digest FROM workflow_work_executions WHERE token=?").get(f.task.token)!;
  expect(JSON.parse(String(row.receipt))).toEqual(receipt);
  expect(row.receipt_digest).toBe(receipt.receipt_digest); recovered.close();
  const results = new WorkArtifactStore(join(restored, "work-artifacts"));
  expect(JSON.parse(results.verify(receipt.output!).toString())).toBe("hello");
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
});
it.each(["application/json", "application/octet-stream"])("keeps large/binary spooled output as an artifact reference (%s)", async media => {
  const f = await executingWork(), receipt = await f.receipt(value => ({ bytes: Buffer.from(JSON.stringify({ result: value, report: "x".repeat(300000) })), media }));
  f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  expect(f.owner.get(f.task.runId).outcome).toEqual({ ok: true, value: { output_artifact: receipt.output } });
  const db = f.inspect();
  expect(Number(db.prepare("SELECT length(outcome) n FROM workflow_runs WHERE id=?").get(f.task.runId)?.n)).toBeLessThan(1000); db.close();
  expect(JSON.parse(f.artifacts.verify(receipt.output!).toString()).result).toBe("hello");
});
it("quarantines an older common-work attempt without typed binding instead of enabling legacy completion", async () => {
  const f = await executingWork(), db = f.inspect();
  db.prepare("DELETE FROM workflow_work_resource_intents WHERE token=?").run(f.task.token);
  db.prepare("DELETE FROM workflow_work_executions WHERE token=?").run(f.task.token); db.close();
  f.owner.tick();
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("needs-attention");
  expect(work.facts.effect).toBe("uncertain");
  expect(work.facts.physical).toBe("unknown");
  expect(() => f.owner.complete("owner", f.task.token, { ok: true, value: "unproven" })).toThrow(/receipt/);
  expect(() => f.owner.settlePhysical("owner", f.task.token)).toThrow(/receipt/);
  expect(f.owner.claimWork("owner", "older-work-retry")).toBeNull();
});
it("lists accepted canonical work with stable pagination and complete counts while the replica is missing", async () => {
  const f = await fixture(), accepted = [];
  for (let index = 0; index < 7; index++) accepted.push(await f.service().submit({ ...f.request, idempotency_key: `page-${index}` }, "alice"));
  const scope = { kind: "identity" as const, installation: "owner", identity_id: "alice" };
  const first = f.owner.listWork(scope, { limit: 2 });
  expect(first.total).toBe(7); expect(first.counts).toEqual({ queued: 7 });
  expect(first.items).toHaveLength(2);
  expect(first.items.every(work => work.projection.applied_revision === 0)).toBe(true);
  const later = await f.service().submit({ ...f.request, idempotency_key: "newer-than-anchor" }, "alice");
  const seen = first.items.map(work => work.work_id); let cursor = first.next_cursor;
  while (cursor) { const next = f.owner.listWork(scope, { limit: 2, cursor }); expect(next.total).toBe(7); seen.push(...next.items.map(work => work.work_id)); cursor = next.next_cursor; }
  expect(new Set(seen)).toEqual(new Set(accepted.map(work => work.work_id)));
  expect(seen).not.toContain(later.work_id);
  expect(f.owner.listWork(scope, {}).total).toBe(8);
});
it("updates canonical state filters/counts with receipt completion without depending on the history target", async () => {
  const f = await executingWork(), scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  expect(f.owner.listWork(scope, { states: ["queued"] }).total).toBe(1);
  const receipt = await f.receipt(); f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  expect(f.owner.listWork(scope, { states: ["queued"] }).total).toBe(0);
  const completed = f.owner.listWork(scope, { states: ["completed"], definition_kind: "workflow", definition_ref: "echo", trigger: "invocation" });
  expect(completed.total).toBe(1); expect(completed.items[0].receipt_ref).toBe(receipt.receipt_ref);
  expect(completed.items[0].allowed_actions).toEqual(["inspect", "result"]);
  expect(f.owner.listWork(scope, { definition_kind: "action" }).total).toBe(0);
});
it("binds cursors to filters and authenticated scope and forbids caller-authored read authority", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) await f.service().submit({ ...f.request, idempotency_key: `cursor-${index}` }, "alice");
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace }, cursor = f.owner.listWork(scope, { limit: 1 }).next_cursor!;
  expect(() => f.owner.listWork(scope, { cursor, states: ["completed"] })).toThrow(/Cursor/);
  expect(() => f.owner.listWork({ kind: "identity", installation: "owner", identity_id: "bob" }, { cursor })).toThrow(/Cursor/);
  expect(() => f.owner.listWork(scope, { cursor: "not-a-cursor" })).toThrow(/Cursor/);
  const service = new WorkReadService({ owner: f.owner, authorize: async (credential: string) => {
    if (credential !== "alice") throw new WorkflowError("Forbidden", "Read permission revoked.", 403);
    return { scope, controls: ["inspect" as const] };
  } });
  await expect(service.list({ scope: { kind: "installation", installation: "owner" } } as never, "alice")).rejects.toThrow();
  await expect(service.list({}, "bob")).rejects.toMatchObject({ status: 403 });
  const list = await service.list({}, "alice");
  expect(list.items.every(work => work.allowed_actions.join() === "inspect")).toBe(true);
});
it("authorizes stable identity history across originating sessions while isolating other identities", async () => {
  const f = await fixture();
  const first = await f.service().submit(f.request, "alice");
  const otherSession = { ...f.authority, namespace: { ...f.authority.namespace, caller_session_id: "session-two" }, origin: { ...f.authority.origin, caller_session_id: "session-two" } };
  const second = await f.service(otherSession).submit({ ...f.request, origin: otherSession.origin }, "alice");
  const scope = { kind: "identity" as const, installation: "owner", identity_id: "alice" };
  expect(new Set(f.owner.listWork(scope, {}).items.map(work => work.work_id))).toEqual(new Set([first.work_id, second.work_id]));
  expect(f.owner.listWork({ kind: "identity", installation: "owner", identity_id: "bob" }, {}).total).toBe(0);
  expect(f.owner.scopedWork({ kind: "identity", installation: "owner", identity_id: "bob" }, first.work_id)).toBeNull();
  const read = new WorkReadService({ owner: f.owner, authorize: async () => ({ scope, controls: ["inspect" as const] }) });
  expect((await read.inspect(second.work_id, "new-device")).work_id).toBe(second.work_id);
});
it("refuses partial upgrade counts and backfills the index in bounded committed batches", async () => {
  const f = await fixture(), accepted = [];
  for (let index = 0; index < 5; index++) accepted.push(await f.service().submit({ ...f.request, idempotency_key: `index-${index}` }, "alice"));
  const db = f.inspect(); db.exec("DELETE FROM workflow_work_index; UPDATE workflow_meta SET value='0' WHERE key='work-index-ready'"); db.close();
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  expect(() => f.owner.listWork(scope, {})).toThrow(/indexing is in progress/);
  expect(f.owner.scopedWork(scope, accepted[0].work_id)?.work_id).toBe(accepted[0].work_id);
  const store = Reflect.get(f.owner, "store") as WorkflowStore;
  backfillWorkIndex(store, 2); backfillWorkIndex(store, 2);
  expect(() => f.owner.listWork(scope, {})).toThrow(/indexing is in progress/);
  backfillWorkIndex(store, 2);
  expect(f.owner.listWork(scope, {}).total).toBe(5);
});
it("rolls index insertion back with admission and uses indexed namespace scans", async () => {
  const f = await fixture(), db = f.inspect();
  db.exec("CREATE TRIGGER index_fault BEFORE INSERT ON workflow_work_index BEGIN SELECT RAISE(ABORT,'injected index failure'); END");
  await expect(f.service().submit(f.request, "alice")).rejects.toThrow(/index failure/);
  expect(f.counts().workflow_runs).toBe(0);
  db.exec("DROP TRIGGER index_fault");
  await f.service().submit(f.request, "alice");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT work_id FROM workflow_work_index WHERE namespace_hash=? ORDER BY accepted_at DESC,work_id DESC LIMIT 50").all(boundFingerprint(f.authority.namespace));
  expect(JSON.stringify(plan)).toContain("workflow_work_index_namespace"); db.close();
});
it("excludes later admissions at equal timestamps and rejects tampered/recovery-generation cursors", async () => {
  const sharedTime = Date.now(), f = await fixture(() => sharedTime), db = f.inspect();
  const accepted = [];
  for (let index = 0; index < 4; index++) accepted.push(await f.service().submit({ ...f.request, idempotency_key: `tie-${index}` }, "alice"));
  expect(new Set(accepted.map(work => work.accepted_at))).toEqual(new Set([sharedTime]));
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  const first = f.owner.listWork(scope, { limit: 1 }), cursor = first.next_cursor!;
  const later = await f.service().submit({ ...f.request, idempotency_key: "later-page" }, "alice");
  const page = f.owner.listWork(scope, { limit: 100, cursor });
  expect(page.items.map(work => work.work_id)).not.toContain(later.work_id);
  expect(page.total).toBe(4);
  const bytes = Buffer.from(cursor, "base64url"); bytes[20] ^= 1;
  expect(() => f.owner.listWork(scope, { cursor: bytes.toString("base64url") })).toThrow(/Cursor/);
  db.prepare("UPDATE workflow_meta SET value=? WHERE key='epoch'").run(`recovered-${sharedTime}`);
  expect(() => f.owner.listWork(scope, { cursor })).toThrow(/Cursor/);
  db.close();
});
it("recovers operation keys across devices and refuses ambiguous or unauthorized origins", async () => {
  const f = await fixture(), first = await f.service().submit(f.request, "alice");
  const scope = { kind: "identity" as const, installation: "owner", identity_id: "alice" };
  const read = new WorkReadService({ owner: f.owner, authorize: async (credential: string) => {
    if (credential !== "alice") throw new WorkflowError("Forbidden", "Not authorized.", 403);
    return { scope, controls: ["inspect" as const] };
  } });
  expect((await read.lookupOperation(f.request.idempotency_key, "alice")).work_id).toBe(first.work_id);
  await expect(read.lookupOperation(f.request.idempotency_key, "bob")).rejects.toMatchObject({ status: 403 });
  const otherSession = { ...f.authority, namespace: { ...f.authority.namespace, caller_session_id: "another-session" }, origin: { ...f.authority.origin, caller_session_id: "another-session" } };
  const second = await f.service(otherSession).submit({ ...f.request, origin: otherSession.origin }, "alice");
  await expect(read.lookupOperation(f.request.idempotency_key, "alice")).rejects.toMatchObject({ code: "WorkOperationAmbiguous" });
  expect((await read.lookupOperation(f.request.idempotency_key, "alice", "another-session")).work_id).toBe(second.work_id);
  expect(f.owner.workOperation({ kind: "identity", installation: "owner", identity_id: "bob" }, f.request.idempotency_key)).toBeNull();
});

async function lateWork() {
  const f = await executingWork(), receipt = await f.receipt(), db = f.inspect();
  db.prepare("UPDATE workflow_commands SET lease_until=0 WHERE id=?").run(f.task.activityId); db.close();
  f.owner.tick(); expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("stale");
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  const request = { request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", expected_revision: work.revision,
    attempt_id: f.task.token, receipt_digest: receipt.receipt_digest,
    reason: "Verified retained result and observed termination from the original execution.", residual_risk: "No new launch; original receipt retains the reported effects." };
  const control = new WorkControlService({ owner: f.owner, authorize: async (credential: string) => {
    if (credential !== "operator") throw new WorkflowError("Forbidden", "Operator approval required.", 403);
    return { actor: "operator-uuid", scope: { kind: "installation" as const, installation: "owner" }, controls: ["reconcile" as const] };
  } });
  return { ...f, receipt, request, control };
}
it("audits applying a retained late receipt and completes without launching the activity again", async () => {
  const f = await lateWork(), ack = await f.control.reconcile(f.accepted.work_id, f.request, "operator");
  expect(ack.receipt_digest).toBe(f.receipt.receipt_digest);
  expect(await f.control.reconcile(f.accepted.work_id, f.request, "operator")).toEqual(ack);
  await f.owner.pump();
  expect(f.owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
  expect(f.owner.claimWork("owner", "reconciled-claim")).toBeNull();
  const db = f.inspect(), audit = JSON.parse(String(db.prepare("SELECT audit FROM workflow_work_reconciliations WHERE run_id=?").get(f.task.runId)?.audit));
  expect(audit).toMatchObject({ actor: "operator-uuid", receiptDigest: f.receipt.receipt_digest, residualRisk: f.request.residual_risk });
  expect(() => db.prepare("UPDATE workflow_work_reconciliations SET audit='{}'").run()).toThrow(/immutable/);
  expect(db.prepare("SELECT count(*) n FROM workflow_work_reconciliations").get()?.n).toBe(1); db.close();
});
it("requires current control permission, exact revision and matching retained evidence before reconciliation", async () => {
  const f = await lateWork();
  await expect(f.control.reconcile(f.accepted.work_id, f.request, "reader")).rejects.toMatchObject({ status: 403 });
  await expect(f.control.reconcile(f.accepted.work_id, { ...f.request, actor: "forged-operator" } as never, "operator")).rejects.toThrow();
  await expect(f.control.reconcile(f.accepted.work_id, { ...f.request, expected_revision: f.request.expected_revision - 1 }, "operator")).rejects.toMatchObject({ code: "WorkRevisionConflict" });
  await expect(f.control.reconcile(f.accepted.work_id, { ...f.request, receipt_digest: "f".repeat(64) }, "operator")).rejects.toMatchObject({ code: "WorkReceiptConflict" });
  await expect(f.control.reconcile(f.accepted.work_id, { ...f.request, attempt_id: "missing-evidence" }, "operator")).rejects.toMatchObject({ code: "WorkReceiptMissing" });
  const readonly = new WorkControlService({ owner: f.owner, authorize: async () => ({ actor: "reader", scope: { kind: "namespace" as const, namespace: f.authority.namespace }, controls: ["inspect" as const] }) });
  await expect(readonly.reconcile(f.accepted.work_id, f.request, "reader")).rejects.toMatchObject({ status: 403 });
  expect(f.owner.get(f.task.runId).status).toBe("blocked");
});
it.each([true, false])("recovers reconciliation COMMIT ambiguity without repeating the effect (applied: %s)", async applied => {
  const f = await lateWork(), store = Reflect.get(f.owner, "store") as WorkflowStore, db = Reflect.get(store, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost reconciliation acknowledgement"); } return original(sql);
  });
  await expect(f.control.reconcile(f.accepted.work_id, f.request, "operator")).rejects.toThrow(/acknowledgement/);
  const ack = await f.control.reconcile(f.accepted.work_id, f.request, "operator");
  expect(ack.receipt_digest).toBe(f.receipt.receipt_digest);
  const inspect = f.inspect(); expect(inspect.prepare("SELECT count(*) n FROM workflow_work_reconciliations").get()?.n).toBe(1); inspect.close();
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
});
it("keeps cancellation decisions and does not allow a reconciliation request ID to change intent", async () => {
  const f = await lateWork();
  await f.control.reconcile(f.accepted.work_id, f.request, "operator");
  await expect(f.control.reconcile(f.accepted.work_id, { ...f.request, reason: "another decision" }, "operator")).rejects.toMatchObject({ code: "WorkControlConflict" });
  const other = await lateWork(); other.owner.cancel(other.task.runId);
  const current = other.owner.workById(other.authority.namespace, other.accepted.work_id)!;
  await expect(other.control.reconcile(other.accepted.work_id, { ...other.request, expected_revision: current.revision }, "operator")).rejects.toMatchObject({ code: "WorkReconciliationConflict" });
  expect(other.owner.get(other.task.runId).status).toBe("cancelled");
});
it("reconciles a restored pending activity from the original worker receipt without rerunning it", async () => {
  const f = await executingWork(), receipt = await f.receipt(), output = f.artifacts.verify(receipt.output!);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(dirname(f.path), "pending-snapshot"), restored = join(dirname(f.path), "pending-restore");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root);
  await f.owner.drain(); f.owner.close(); await restoreWorkflows(snapshot, restored, "owner", true);
  const artifacts = new WorkArtifactStore(join(restored, "work-artifacts"));
  artifacts.stage(output, { owner_identity: receipt.output!.owner_identity, purpose: "output", media_type: receipt.output!.media_type });
  const owner = new WorkflowOwner({ id: "owner", path: join(restored, "workflows.db"), artifacts: [f.workflow],
    activityArtifacts: { echo: f.workflow.digest }, executor: new ProcessExecutor(), workArtifacts: artifacts, workResources: f.workResources, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("stale");
  const work = owner.workById(f.authority.namespace, f.accepted.work_id)!;
  const request = { request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", expected_revision: work.revision,
    attempt_id: f.task.token, receipt_digest: receipt.receipt_digest, reason: "Previous owner fenced; original worker receipt recovered.", residual_risk: "Apply known evidence only; no execution repeated." };
  expect(owner.reconcileWorkReceipt(work.work_id, request, "operator-uuid").receipt_digest).toBe(receipt.receipt_digest);
  await owner.pump();
  expect(owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
});
it("cannot promote an uncertain receipt or a receipt missing its retained output", async () => {
  const f = await executingWork();
  const claim = f.journal.claimStage(f.binding, "execution"); f.owner.observeWork("owner", f.task.token, claim.observation);
  const unsigned = { ...f.binding, receipt_ref: "uncertain-proof", revision: claim.observation.revision + 1, committed_at: Date.now(),
    physical_state: "ceased" as const, effect_certainty: "uncertain" as const, outcome: "uncertain" as const,
    stages: [], output: null, summary: "No validated result survived.", validation: "unknown" as const, validation_failures: null };
  const receipt = { ...unsigned, receipt_digest: workReceiptDigest(unsigned) };
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  const request = { request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", expected_revision: work.revision, attempt_id: f.task.token,
    receipt_digest: receipt.receipt_digest, reason: "Attempted promotion", residual_risk: "Uncertain evidence remains." };
  expect(() => f.owner.reconcileWorkReceipt(work.work_id, request, "operator-uuid")).toThrow(/does not prove/);
  const known = await lateWork(); rmSync(known.artifacts.path(known.receipt.output!));
  rmSync(join(known.artifacts.root, ".executor-retained"), { recursive: true, force: true });
  await expect(known.control.reconcile(known.accepted.work_id, known.request, "operator")).rejects.toThrow();
  expect(known.owner.get(known.task.runId).status).toBe("blocked");
});
it.each(["action", "job"])("settles a never-dispatched %s at its dispatch deadline with a structured no-effect reason", async kind => {
  let now = Date.now(); const f = await fixture(() => now);
  const request = { ...f.request, definition: kind === "action" ? { kind: "action" as const, reference: "echo", catalog_namespace: "caller" } : { kind: "job" as const, reference: "echo" } };
  const service = f.service(f.authority, async (input, authority) => {
    const resolved = f.resolution(input, authority); resolved.plan.dispatch_budget_ms = 50; return resolved;
  });
  const accepted = await service.submit(request, "alice"); await f.owner.pump();
  now = accepted.dispatch_deadline - 1; f.owner.tick();
  expect(f.owner.get(accepted.workflow_id).status).toBe("running");
  now = accepted.dispatch_deadline; f.owner.tick();
  const work = f.owner.workById(f.authority.namespace, accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("failed");
  expect(work.reason).toMatchObject({ code: "dispatch_timeout", stage: "placement", retryable: false });
  expect(work.facts).toMatchObject({ physical: "not-started", effect: "not-started" });
  expect(work.first_started_at).toBeNull();
  const db = f.inspect();
  expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0);
  expect(db.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(accepted.workflow_id)?.state).toBe("released"); db.close();
  expect((await service.submit(request, "alice")).work_id).toBe(accepted.work_id);
});
it("keeps older issued attempts uncertain at dispatch expiry and does not repeatedly append blocking events", async () => {
  let now = Date.now(); const f = await fixture(() => now);
  const request = { ...f.request, definition: { kind: "action" as const, reference: "echo", catalog_namespace: "caller" } };
  const service = f.service(f.authority, async (input, authority) => { const resolved = f.resolution(input, authority); resolved.plan.dispatch_budget_ms = 50; return resolved; });
  const accepted = await service.submit(request, "alice"); await f.owner.pump();
  const feature = f.features();
  f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...feature, observed_at: now, expires_at: now + 15000, features: [...feature.features], executors: [...feature.executors] });
  const task = f.owner.claimWork("owner", "older-dispatch")!;
  const db = f.inspect();
  const record = JSON.parse(String(db.prepare("SELECT record FROM workflow_work_admissions WHERE run_id=?").get(task.runId)?.record));
  record.first_started_at = null; record.execution_deadline = null;
  db.prepare("UPDATE workflow_work_admissions SET record=? WHERE run_id=?").run(JSON.stringify(record), task.runId);
  db.prepare("DELETE FROM workflow_work_resource_intents WHERE token=?").run(task.token);
  db.prepare("DELETE FROM workflow_work_executions WHERE token=?").run(task.token);
  now = accepted.dispatch_deadline; f.owner.tick();
  const work = f.owner.workById(f.authority.namespace, accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("needs-attention");
  expect(f.owner.get(task.runId).status).toBe("blocked");
  expect(db.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(task.runId)?.state).toBe("reserved");
  const count = db.prepare("SELECT count(*) n FROM workflow_events WHERE run_id=? AND type='WorkflowBlocked'").get(task.runId)?.n;
  now += 100; f.owner.tick();
  expect(db.prepare("SELECT count(*) n FROM workflow_events WHERE run_id=? AND type='WorkflowBlocked'").get(task.runId)?.n).toBe(count); db.close();
});
async function reservedWork() {
  let now = Date.now(); const f = await fixture(() => now);
  const request = { ...f.request, definition: { kind: "action" as const, reference: "echo", catalog_namespace: "caller" } };
  const service = f.service(f.authority, async (input, authority) => { const resolved = f.resolution(input, authority); resolved.plan.dispatch_budget_ms = 100; resolved.plan.execution_budget_ms = 50; return resolved; });
  const accepted = await service.submit(request, "alice"); await f.owner.pump();
  const features = f.features();
  f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...features, observed_at: now, expires_at: now + 15000, executors: [...features.executors], features: [...features.features] });
  const task = f.owner.claimWork("owner", "reserve-first")!;
  return { ...f, accepted, task, now: () => now, advance: (ms: number) => { now += ms; } };
}
it("starts the execution clock at launch authorization, not claim, and rejects reservation launch", async () => {
  const f = await reservedWork(), initial = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(initial.first_started_at).toBeNull(); expect(initial.execution_deadline).toBeNull();
  expect(f.task.work!.launch_authorized).toBe(false);
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "permit-journal.db"), installation: "owner" }); cleanup.push(() => journal.close());
  expect(() => journal.start(f.task.work!)).toThrow(/reservation/);
  expect(f.owner.assertWorkEffect("owner", f.task.token)).toBe(false);
  f.advance(80);
  const start = f.owner.beginWork("owner", f.task.token), work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(start.launch_authorized).toBe(true);
  expect(work.first_started_at).toBe(f.now()); expect(work.execution_deadline).toBe(f.now() + 50);
  expect(start.deadline).toBe(f.now() + 50);
  f.advance(10); expect(f.owner.beginWork("owner", f.task.token)).toEqual(start);
  expect(f.owner.workById(f.authority.namespace, work.work_id)?.execution_deadline).toBe(work.execution_deadline);
});
it("expires an unactivated reservation without effects and fences delayed launch requests", async () => {
  const f = await reservedWork(); f.advance(100); f.owner.tick();
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(projectWorkState(work.facts).state).toBe("failed");
  expect(work.facts).toMatchObject({ physical: "ceased", effect: "not-started" });
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/expired|stopped/);
  const db = f.inspect();
  expect(db.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(work.workflow_id)?.state).toBe("released"); db.close();
});
it.each([true, false])("recovers launch-permit COMMIT ambiguity with one immutable deadline (applied: %s)", async applied => {
  const f = await reservedWork(); f.advance(10);
  const firstTime = f.now(), store = Reflect.get(f.owner, "store") as WorkflowStore, db = Reflect.get(store, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost launch authorization acknowledgement"); } return original(sql);
  });
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/acknowledgement/);
  f.advance(10); const start = f.owner.beginWork("owner", f.task.token);
  expect(start.deadline).toBe((applied ? firstTime : f.now()) + 50);
  expect(f.owner.beginWork("owner", f.task.token)).toEqual(start);
  const inspect = f.inspect(); expect(inspect.prepare("SELECT count(*) n FROM workflow_events WHERE run_id=? AND type='WorkLaunchAuthorized'").get(f.task.runId)?.n).toBe(1); inspect.close();
});
it("rechecks policy before activation and never converts an unactivated reservation into executed evidence", async () => {
  const f = await reservedWork(); f.denyEffects();
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/Current full execution policy/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, f.task.work![key as keyof typeof f.task.work]])));
  expect(() => f.owner.observeWork("owner", f.task.token, { ...binding, revision: 2, observed_at: f.now(), stage: "execution", physical_state: "running", effect_certainty: "uncertain", cancel_requested: false, reason: null, receipt_ref: null, handle: null })).toThrow(/no permission/);
});
it("retains one launch permit across owner restart and refuses subsequent binding edits", async () => {
  const f = await reservedWork(); f.advance(20); const start = f.owner.beginWork("owner", f.task.token);
  const deadline = f.owner.workById(f.authority.namespace, f.accepted.work_id)!.execution_deadline;
  const db = f.inspect();
  expect(() => db.prepare("UPDATE workflow_work_executions SET request=json_set(request,'$.deadline',?) WHERE token=?").run(start.deadline + 100, f.task.token)).toThrow(/immutable/);
  db.close(); await f.owner.drain(); f.owner.close();
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest },
    executor: new ProcessExecutor(), workArtifacts: f.artifacts, now: f.now, workResources: f.workResources, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.beginWork("owner", f.task.token)).toEqual(start);
  expect(owner.workById(f.authority.namespace, f.accepted.work_id)?.execution_deadline).toBe(deadline);
});
it("fences cancellation before activation and rejects a permit from another worker", async () => {
  const f = await reservedWork();
  expect(() => f.owner.beginWork("other", f.task.token)).toThrow(/binding/);
  f.owner.cancel(f.task.runId);
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/expired|stopped/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
});
it.each([true, false])("recovers broker acquisition COMMIT ambiguity before issuing a launch permit (applied: %s)", async applied => {
  const f = await reservedWork(), db = Reflect.get(f.broker, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost broker acquisition acknowledgement"); }
    return original(sql);
  });
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/acknowledgement/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
  const start = f.owner.beginWork("owner", f.task.token);
  expect(start.resources.host_reservation).toMatch(/^res_/);
  const inspect = f.inspect(), intent = inspect.prepare("SELECT request,reservation FROM workflow_work_resource_intents WHERE token=? AND role='host'").get(f.task.token)!;
  expect(f.broker.lookup(JSON.parse(String(intent.request)))?.reservation).toBe(start.resources.host_reservation);
  expect(intent.reservation).toBe(start.resources.host_reservation); inspect.close();
  expect(f.owner.beginWork("owner", f.task.token)).toEqual(start);
});
it("refuses live effects from unknown or released aggregate capacity", async () => {
  const f = await reservedWork(), start = f.owner.beginWork("owner", f.task.token);
  expect(f.owner.assertWorkEffect("owner", f.task.token)).toBe(true);
  f.broker.markUnknown(start.resources.host_reservation!);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/capacity/);
  expect(f.owner.heartbeat("owner", f.task.token)).toBe(false);
  expect(f.owner.beginWork("owner", f.task.token)).toEqual(start); // Read acknowledgement does not renew authority.
});
it.each([true, false])("recovers resource settlement after durable owner acceptance and broker COMMIT loss (applied: %s)", async applied => {
  const f = await executingWork(), proof = await f.receipt(), db = Reflect.get(f.broker, "db") as SqliteDatabase, original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
    if (sql === "COMMIT") { if (applied) original(sql); throw new Error("lost broker settlement acknowledgement"); }
    return original(sql);
  });
  expect(() => f.owner.completeWorkReceipt("owner", f.task.token, proof)).toThrow(/acknowledgement/);
  const inspect = f.inspect();
  expect(inspect.prepare("SELECT receipt_digest FROM workflow_work_executions WHERE token=?").get(f.task.token)?.receipt_digest).toBe(proof.receipt_digest);
  expect(inspect.prepare("SELECT reconciled FROM workflow_work_resource_intents WHERE token=?").get(f.task.token)?.reconciled).toBe(0); inspect.close();
  expect(f.owner.reconcileWorkResources()).toBe(1);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.reconcileWorkResources()).toBe(0);
  expect(f.owner.completeWorkReceipt("owner", f.task.token, proof)).toBe("alreadyAccepted");
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
});
it("recovers partial host/endpoint acquisition by fencing an unlaunched reservation, without releasing unrelated endpoint work", async () => {
  let now = Date.now(); const f = await fixture(() => now);
  const endpoint = new WorkResourceBroker({ path: join(dirname(f.path), "endpoint.db"), broker: "model-owner",
    limits: { inference: { kind: "endpoint", concurrency: 1, input_tokens: 100, output_tokens: 100, cost_micros: 1_000_000 } }, now: () => now });
  cleanup.push(() => endpoint.close()); f.workResources.brokers.set("model-owner", endpoint);
  const input = { ...f.request, definition: { kind: "action" as const, reference: "echo", catalog_namespace: "caller" } };
  const service = f.service(f.authority, async (request, authority) => {
    const resolved = f.resolution(request, authority); resolved.plan.dispatch_budget_ms = 100;
    resolved.plan.resources.endpoint = { broker: "model-owner", endpoint: "inference", reservation: null, model: "test", max_input_tokens: 10, max_output_tokens: 10, max_cost: 0.01 };
    return resolved;
  });
  const accepted = await service.submit(input, "alice"); await f.owner.pump();
  const features = f.features(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...features, observed_at: now, expires_at: now + 15000, executors: [...features.executors], features: [...features.features] });
  const task = f.owner.claimWork("owner", "partial-resources")!, inspect = f.inspect();
  const intent = (role: string) => JSON.parse(String(inspect.prepare("SELECT request FROM workflow_work_resource_intents WHERE token=? AND role=?").get(task.token, role)?.request)) as WorkResourceRequest;
  const busy = intent("endpoint"); busy.binding = { ...busy.binding, attempt_id: "unrelated-endpoint", activity_id: "unrelated" };
  const unrelated = endpoint.acquire([busy])[0];
  expect(() => f.owner.beginWork("owner", task.token)).toThrow(/occupied/);
  const held = f.broker.lookup(intent("host"))!; expect(held.state).toBe("held");
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.first_started_at).toBeNull();
  expect(inspect.prepare("SELECT reservation FROM workflow_work_resource_intents WHERE token=? AND role='host'").get(task.token)?.reservation).toBeNull();
  now = accepted.dispatch_deadline; f.owner.tick();
  expect(f.owner.reconcileWorkResources()).toBe(2);
  expect(f.broker.inspect(held.reservation)?.state).toBe("released");
  expect(endpoint.inspect(unrelated.reservation)?.state).toBe("held");
  expect(endpoint.lookup(intent("endpoint"))).toBeNull(); inspect.close();
  expect(() => f.owner.beginWork("owner", task.token)).toThrow(/expired|stopped/);
});
it("fails closed when a restarted owner lacks its required resource arbiter", async () => {
  const f = await reservedWork(); await f.owner.drain(); f.owner.close();
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest },
    executor: new ProcessExecutor(), workArtifacts: f.artifacts, now: f.now, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(() => owner.beginWork("owner", f.task.token)).toThrow(/arbiter/);
  expect(owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
});
it("starts the execution budget after resource acquisition and rechecks expiry before permission", async () => {
  const f = await reservedWork(), acquire = f.broker.acquire.bind(f.broker);
  vi.spyOn(f.broker, "acquire").mockImplementation(requests => { const held = acquire(requests); f.advance(80); return held; });
  const start = f.owner.beginWork("owner", f.task.token);
  expect(start.deadline).toBe(f.now() + 50);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBe(f.now());
});
it("fences an acquisition that finishes after dispatch expiry and recovers its orphan capacity", async () => {
  const f = await reservedWork(), acquire = f.broker.acquire.bind(f.broker);
  vi.spyOn(f.broker, "acquire").mockImplementation(requests => { const held = acquire(requests); f.advance(100); return held; });
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/expired/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
  f.owner.tick(); expect(f.owner.reconcileWorkResources()).toBe(1);
  const inspect = f.inspect(), row = inspect.prepare("SELECT request FROM workflow_work_resource_intents WHERE token=?").get(f.task.token)!;
  expect(f.broker.lookup(JSON.parse(String(row.request)))?.state).toBe("released"); inspect.close();
});
it("rechecks current policy after acquiring capacity before committing launch permission", async () => {
  const f = await reservedWork(), acquire = f.broker.acquire.bind(f.broker);
  vi.spyOn(f.broker, "acquire").mockImplementation(requests => { const held = acquire(requests); f.denyEffects(); return held; });
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/Current full execution policy/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
  f.owner.cancel(f.task.runId); expect(f.owner.reconcileWorkResources()).toBe(1);
});
it("refuses a resource adapter whose durable identity differs from its configured broker reference", async () => {
  const f = await reservedWork();
  const foreign = new WorkResourceBroker({ path: join(dirname(f.path), "foreign-resource.db"), broker: "other-installation", limits: { local: { kind: "host" } } });
  cleanup.push(() => foreign.close()); f.workResources.brokers.set("local-host", foreign);
  expect(() => f.owner.beginWork("owner", f.task.token)).toThrow(/arbiter/);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
});
it("settles a never-authorized claim at lease expiry without inventing uncertain effects", async () => {
  let now = Date.now(); const f = await fixture(() => now);
  const accepted = await f.service().submit(f.request, "alice"); await f.owner.pump();
  const features = f.features(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...features, observed_at: now, expires_at: now + 15000, executors: [...features.executors], features: [...features.features] });
  const task = f.owner.claimWork("owner", "expire-before-authorization")!, inspect = f.inspect();
  const lease = Number(inspect.prepare("SELECT lease_until FROM workflow_commands WHERE token=?").get(task.token)?.lease_until);
  expect(lease).toBeLessThan(accepted.dispatch_deadline);
  now = lease; f.owner.tick(); await f.owner.pump();
  expect(f.owner.get(task.runId).status).toBe("failed");
  expect(f.owner.inspect(task.runId).commands[0].outcome).toMatchObject({ ok: false, error: { code: "WorkLaunchExpired" } });
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.facts).toMatchObject({ physical: "ceased", effect: "not-started" });
  expect(() => f.owner.beginWork("owner", task.token)).toThrow(/expired|stopped/);
  expect(f.owner.reconcileWorkResources()).toBe(1);
  expect(inspect.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(task.runId)?.state).toBe("released"); inspect.close();
});
async function waitingWorkflow(delay = 200, overall = 1000, repeatDelay?: number) {
  let now = Date.now();
  const f = await fixture(() => now, fileURLToPath(new URL("./work-timing-fixture.mjs", import.meta.url)));
  const request = { ...f.request, inputs: { delay_ms: delay, value: "after-wait", ...(repeatDelay === undefined ? {} : { repeat_delay_ms: repeatDelay }) } };
  const service = f.service(f.authority, async (input, authority) => {
    const resolved = f.resolution(input, authority);
    resolved.plan.dispatch_budget_ms = 100; resolved.plan.execution_budget_ms = repeatDelay === undefined ? 50 : 60000; resolved.plan.overall_budget_ms = overall;
    return resolved;
  });
  const accepted = await service.submit(request, "alice"); await f.owner.pump();
  const advertise = (owner = f.owner) => {
    const features = f.features(); owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
      { ...features, observed_at: now, expires_at: now + 15000, executors: [...features.executors], features: [...features.features] });
  };
  return { ...f, request, accepted, service, advertise, now: () => now, advance: (ms: number) => { now += ms; } };
}
it("does not spend an activity dispatch budget or physical slot during an authored future timer", async () => {
  const f = await waitingWorkflow(), inspect = f.inspect();
  f.advance(100); f.owner.tick(); await f.owner.pump();
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("running");
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.facts.wait).toBe("timer");
  expect(inspect.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0);
  expect(inspect.prepare("SELECT count(*) n FROM workflow_work_resource_intents").get()?.n).toBe(0);
  f.advance(100); f.owner.tick(); await f.owner.pump();
  const command = inspect.prepare("SELECT * FROM workflow_commands WHERE json_extract(definition,'$.kind')='activity'").get()!;
  expect(command.work_eligible_at).toBe(f.now()); expect(command.work_dispatch_deadline).toBe(f.now() + 100);
  f.advertise(); const task = f.owner.claimWork("owner", "future-timer-claim")!;
  expect(task).not.toBeNull(); f.advance(50);
  const permit = f.owner.beginWork("owner", task.token);
  expect(permit.deadline).toBe(f.now() + 50);
  expect(f.owner.get(task.runId).deadline).toBe(f.accepted.accepted_at + 1000);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBe(f.now()); inspect.close();
});
it("expires an eligible generic activity at its own window with a structured no-effect reason", async () => {
  const f = await waitingWorkflow(); f.advance(200); f.owner.tick(); await f.owner.pump();
  f.advance(99); f.owner.tick(); await f.owner.pump(); expect(f.owner.get(f.accepted.workflow_id).status).toBe("running");
  f.advance(1); f.owner.tick(); await f.owner.pump();
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("failed");
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(work.reason).toMatchObject({ code: "dispatch_timeout", since: f.now(), stage: "placement" });
  expect(work.facts.effect).toBe("not-started"); expect(work.first_started_at).toBeNull();
  const inspect = f.inspect(); expect(inspect.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(work.workflow_id)?.state).toBe("released"); inspect.close();
});
it("preserves eligible dispatch windows and overall lifetime across owner restart and same-key retry", async () => {
  const f = await waitingWorkflow(); f.advance(200); f.owner.tick(); await f.owner.pump();
  const inspect = f.inspect(), command = inspect.prepare("SELECT * FROM workflow_commands WHERE json_extract(definition,'$.kind')='activity'").get()!;
  expect(() => inspect.prepare("UPDATE workflow_commands SET work_dispatch_deadline=work_dispatch_deadline+100 WHERE id=?").run(String(command.id))).toThrow(/immutable/); inspect.close();
  await f.owner.drain(); f.owner.close(); f.advance(50);
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest }, executor: new ProcessExecutor(),
    workArtifacts: f.artifacts, workResources: f.workResources, now: f.now, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  f.advertise(owner); const task = owner.claimWork("owner", "restart-timer-claim")!;
  expect(owner.beginWork("owner", task.token).deadline).toBe(f.now() + 50);
  expect(owner.get(task.runId).deadline).toBe(f.accepted.accepted_at + 1000);
  const service = new WorkAdmissionService({ owner, authenticate: async () => f.authority, resolve: async () => { throw new Error("retry must not resolve a new lifetime"); } });
  expect((await service.submit(f.request, "alice")).plan.overall_budget_ms).toBe(1000);
});
it("enforces declared overall lifetime during a dependency wait without consuming physical capacity", async () => {
  const f = await waitingWorkflow(2000, 500); f.advance(500); f.owner.tick(); await f.owner.pump();
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("timed_out");
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
  const inspect = f.inspect(); expect(inspect.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0); inspect.close();
});
it("releases physical capacity for a dependency wait after real execution and keeps the original execution deadline", async () => {
  const f = await waitingWorkflow(200, 120000, 200); f.advance(200); f.owner.tick(); await f.owner.pump(); f.advertise();
  const task = f.owner.claimWork("owner", "first-timed-stage")!, start = f.owner.beginWork("owner", task.token);
  const deadline = f.owner.workById(f.authority.namespace, f.accepted.work_id)!.execution_deadline;
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "timed-journal.db"), installation: "owner", artifacts: f.artifacts, now: f.now }); cleanup.push(() => journal.close());
  journal.start(start); const claim = journal.claimStage(binding, "execution"); expect(claim.launch).toBe(true);
  f.owner.observeWork("owner", task.token, claim.observation); expect(f.owner.assertWorkEffect("owner", task.token)).toBe(true);
  const value = await f.executor.activity(f.workflow)(task.input, { ...task, work: start, deadline: start.deadline, timeoutMs: 60000, signal: new AbortController().signal });
  const output = f.artifacts.stage(Buffer.from(JSON.stringify(value)), { owner_identity: "alice", purpose: "output", media_type: "application/json" });
  journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), attempt_id: task.token,
    state: "passed", started_at: f.now(), completed_at: f.now(), result: output }, "ceased");
  const unsigned = { ...binding, receipt_ref: journal.newReceiptRef(), revision: journal.inspect(binding)!.revision + 1, committed_at: f.now(), physical_state: "ceased" as const,
    effect_certainty: "known" as const, outcome: "complete" as const, stages: journal.stageReceipts(binding), output, summary: "real timed echo", validation: "skipped" as const, validation_failures: null };
  f.owner.completeWorkReceipt("owner", task.token, journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) })); await f.owner.pump();
  expect(value).toBe("after-wait"); expect(f.broker.inspect(start.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.facts.wait).toBe("timer");
  f.advance(200); f.owner.tick(); await f.owner.pump(); f.advertise();
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("running");
  // The fair cursor may return an empty page while wrapping to this same run.
  const second = f.owner.claimWork("owner") ?? f.owner.claimWork("owner");
  expect(second).not.toBeNull();
  expect(second!.activityId).not.toBe(task.activityId);
  expect(f.owner.beginWork("owner", second!.token).deadline).toBe(deadline);
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.execution_deadline).toBe(deadline);
});
it("retains the legacy admission-anchored timing for plans without a separate overall lifetime", async () => {
  let now = Date.now(); const f = await fixture(() => now), accepted = await f.service().submit(f.request, "alice");
  now += 50; await f.owner.pump();
  const inspect = f.inspect(), command = inspect.prepare("SELECT work_eligible_at,work_dispatch_deadline,deadline FROM workflow_commands").get()!;
  expect(command.work_eligible_at).toBeNull(); expect(command.work_dispatch_deadline).toBeNull();
  expect(command.deadline).toBe(accepted.dispatch_deadline);
  expect(f.owner.get(accepted.workflow_id).deadline).toBe(accepted.accepted_at + accepted.plan.dispatch_budget_ms + accepted.plan.execution_budget_ms); inspect.close();
});
it.each([
  {effectClass: "pure", retryable: true, retryBudget: 5000, failureCode: "TransientAbort", retry: true, commit: undefined},
  {effectClass: "repeatable", retryable: true, retryBudget: 5000, failureCode: "TransientAbort", retry: true, commit: undefined},
  {effectClass: "non-repeatable", retryable: true, retryBudget: 5000, failureCode: "TransientAbort", retry: false, commit: undefined},
  {effectClass: "pure", retryable: false, retryBudget: 5000, failureCode: "PermanentFailure", retry: false, commit: undefined},
  {effectClass: "pure", retryable: true, retryBudget: 1, failureCode: "TransientAbort", retry: false, commit: undefined},
  {effectClass: "pure", retryable: true, retryBudget: 5000, failureCode: "SchemaError", retry: false, commit: undefined},
  {effectClass: "pure", retryable: true, retryBudget: 5000, failureCode: "TransientAbort", retry: true, commit: true},
  {effectClass: "pure", retryable: true, retryBudget: 5000, failureCode: "TransientAbort", retry: true, commit: false},
] as const)("applies declared retry policy $effectClass/$failureCode/$retryable/$retryBudget after real child settlement", async scenario => {
  let now = Date.now(); const f = await fixture(() => now);
  const service = f.service(f.authority, async (request, authority) => { const resolved = f.resolution(request, authority);
    resolved.plan.effect_policy = scenario.effectClass === "non-repeatable" ? {class: "non-repeatable", max_attempts: 1} : { class: scenario.effectClass, max_attempts: 2, retry_budget_ms: scenario.retryBudget }; return resolved; });
  const accepted = await service.submit(f.request, "alice"); await f.owner.pump();
  const features = f.features(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...features, observed_at: now, expires_at: now + 15000, executors: [...features.executors], features: [...features.features, "bounded-retries"] });
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "retry-journal.db"), installation: "owner", artifacts: f.artifacts, now: () => now }); cleanup.push(() => journal.close());
  const attempt = async (task: NonNullable<ReturnType<WorkflowOwner["claimWork"]>>, fail: boolean) => {
    const start = f.owner.beginWork("owner", task.token), binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));
    journal.start(start); const claim = journal.claimStage(binding, "execution"); expect(claim.launch).toBe(true); f.owner.observeWork("owner", task.token, claim.observation);
    const stop = new AbortController();
    let output = null;
    if (fail) {
      const running = f.executor.activity(f.workflow)(task.input, { ...task, work: start, timeoutMs: 60000, signal: stop.signal });
      expect((Reflect.get(f.executor, "running") as Set<unknown>).size).toBe(1);
      stop.abort(); await expect(running).rejects.toThrow();
      expect((Reflect.get(f.executor, "running") as Set<unknown>).size).toBe(0);
    }
    else { const value = await f.executor.activity(f.workflow)(task.input, { ...task, work: start, timeoutMs: 60000, signal: stop.signal });
      output = f.artifacts.stage(Buffer.from(JSON.stringify(value)), { owner_identity: "alice", purpose: "output", media_type: "application/json" }); }
    journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), attempt_id: task.token,
      state: fail ? "failed" : "passed", started_at: now, completed_at: now, result: output }, "ceased");
    const body = { ...binding, receipt_ref: journal.newReceiptRef(), revision: journal.inspect(binding)!.revision + 1, committed_at: now, physical_state: "ceased" as const,
      effect_certainty: "known" as const, outcome: fail ? "failed" as const : "complete" as const, stages: journal.stageReceipts(binding), output,
      summary: fail ? "transient child abort" : "retry succeeded", validation: "skipped" as const, validation_failures: null,
      ...(fail ? { failure: { code: scenario.failureCode, retryable: scenario.retryable } } : {}) };
    const receipt = journal.commitReceipt(binding, { ...body, receipt_digest: workReceiptDigest(body) });
    if (fail && scenario.commit !== undefined) {
      const store = Reflect.get(f.owner, "store") as WorkflowStore, db = Reflect.get(store, "db") as SqliteDatabase, original = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementationOnce(sql => original(sql)).mockImplementationOnce(sql => {
        if (sql === "COMMIT") { if (scenario.commit) original(sql); throw new Error("lost retry scheduling acknowledgement"); } return original(sql);
      });
      expect(() => f.owner.completeWorkReceipt("owner", task.token, receipt)).toThrow(/acknowledgement/);
    }
    f.owner.completeWorkReceipt("owner", task.token, receipt); return { start, binding, receipt };
  };
  const first = f.owner.claimWork("owner", "retry-first")!;
  const failed = await attempt(first, true), budget = f.owner.workById(f.authority.namespace, accepted.work_id)!.execution_deadline;
  expect(f.broker.inspect(failed.start.resources.host_reservation!)?.state).toBe("released");
  if (!scenario.retry) {
    await f.owner.pump(); expect(f.owner.get(first.runId).status).toBe("failed");
    expect(f.owner.claimWork("owner")).toBeNull(); return;
  }
  expect(f.owner.get(first.runId).status).toBe("running");
  now += 1000; const second = f.owner.claimWork("owner") ?? f.owner.claimWork("owner"); expect(second).not.toBeNull();
  expect(second!.activityId).toBe(first.activityId); expect(second!.token).not.toBe(first.token);
  const succeeded = await attempt(second!, false); await f.owner.pump();
  expect(succeeded.start.retry_from?.receipt_digest).toBe(failed.receipt.receipt_digest);
  expect(succeeded.receipt.stages[0].effect_key).toBe(failed.receipt.stages[0].effect_key);
  expect(f.owner.get(first.runId).outcome).toEqual({ ok: true, value: "hello" });
  expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.execution_deadline).toBe(budget);
  expect(journal.receipt(failed.binding)?.outcome).toBe("failed"); expect(journal.receipt(succeeded.binding)?.outcome).toBe("complete");
  const inspect = f.inspect(); expect(inspect.prepare("SELECT count(*) n FROM workflow_events WHERE run_id=? AND type='WorkRetryScheduled'").get(first.runId)?.n).toBe(1); inspect.close();
});
it.each(["action", "job"] as const)("refuses a separate overall-lifetime override for compatibility %s plans", async kind => {
  const f = await fixture(), request = { ...f.request, definition: kind === "action" ? { kind, reference: "echo", catalog_namespace: "caller" } : { kind, reference: "echo" } };
  const service = f.service(f.authority, async (input, authority) => { const resolved = f.resolution(input, authority); resolved.plan.overall_budget_ms = 1000; return resolved; });
  await expect(service.submit(request, "alice")).rejects.toThrow(/Separate overall lifetime/);
  expect(f.counts().workflow_runs).toBe(0);
});


// Regressions ported from the independent review of 73f3bf252.
it("review regression: retained executor output remains available through owner staging collection", async () => {
  const f = await executingWork(), receipt = await f.receipt();
  const old = new Date(Date.now() - 3 * 86400000);
  utimesSync(f.artifacts.path(receipt.output!), old, old);
  expect(f.journal.receipt(f.binding)?.receipt_digest).toBe(receipt.receipt_digest);
  // Simulate the previous journal version, which had no spool ownership pins.
  rmSync(join(f.artifacts.root, ".executor-retained"), { recursive: true, force: true });
  const legacy = new SqliteDatabase(join(dirname(f.path), "executor.db"));
  legacy.exec("PRAGMA user_version=1"); legacy.close();
  const reopenedArtifacts = new WorkArtifactStore(f.artifacts.root);
  const reopened = new ExecutorJournal({ path: join(dirname(f.path), "executor.db"), installation: "owner", artifacts: reopenedArtifacts });
  cleanup.push(() => reopened.close());
  expect(reopened.receipt(f.binding)?.receipt_digest).toBe(receipt.receipt_digest);
  const orphan = reopenedArtifacts.stage(Buffer.from("unreferenced"), { owner_identity: "alice", purpose: "output", media_type: "text/plain" });
  utimesSync(reopenedArtifacts.path(orphan), old, old);
  f.owner.collectWorkStaging();
  expect(existsSync(reopenedArtifacts.path(receipt.output!))).toBe(true);
  expect(existsSync(reopenedArtifacts.path(orphan))).toBe(false);
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
  f.owner.collectWorkStaging();
  rmSync(reopenedArtifacts.path(receipt.output!));
  expect(reopenedArtifacts.verify(receipt.output!)).toEqual(f.artifacts.verify(receipt.output!));
});
it("review regression: a known live execution projects running rather than recovery attention", async () => {
  const f = await executingWork();
  f.journal.claimStage(f.binding, "execution");
  const observed = f.journal.recordHandle(f.binding, "execution", {
    kind: "process", installation: "owner", boot_identity: "boot", pid: process.pid, start_identity: "review-fixture"
  });
  f.owner.observeWork("owner", f.task.token, observed);
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(work.facts.physical).toBe("running");
  expect(projectWorkState(work.facts).state).toBe("running");
  expect(projectWorkState(work.facts).allowed_actions).not.toContain("reconcile");
  const db = f.inspect(), previous = db.prepare("SELECT sequence FROM workflow_work_index WHERE work_id=?").get(work.work_id);
  db.prepare("UPDATE workflow_work_index SET state='needs-attention' WHERE work_id=?").run(work.work_id);
  db.exec(readFileSync(fileURLToPath(new URL("../../../bags/workflows/migrations/workflows/017_live_work_projection.sql", import.meta.url)), "utf8"));
  expect(db.prepare("SELECT sequence FROM workflow_work_index WHERE work_id=?").get(work.work_id)).toEqual(previous);
  db.close();
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  expect(f.owner.listWork(scope, { states: ["running"] }).total).toBe(1);
  expect(f.owner.listWork(scope, { states: ["needs-attention"] }).total).toBe(0);
});
it.each(["not-json", "1e999", "[".repeat(66) + "0" + "]".repeat(66)])("review regression: invalid JSON %s records cessation and a content failure", async (invalid) => {
  const f = await executingWork(), receipt = await f.receipt(() => ({bytes: Buffer.from(invalid), media: "application/json"}));
  let error: unknown;
  try { f.owner.completeWorkReceipt("owner", f.task.token, receipt); } catch (caught) { error = caught; }
  const db = f.inspect();
  const row = db.prepare("SELECT physical_state FROM workflow_attempts WHERE token=?").get(f.task.token);
  db.close();
  expect(error).toBeUndefined();
  expect(row?.physical_state).toBe("settled");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
  const retained = Reflect.get(f.owner, "executionOwner").retainedReceipt(f.task.token);
  expect(retained.invalid_output).toMatch(/JSON/);
  expect(retained.receipt.receipt_digest).toBe(receipt.receipt_digest);
  expect(f.artifacts.verify(retained.receipt.output!)).toEqual(Buffer.from(invalid));
  await f.owner.pump();
  expect(f.owner.get(f.task.runId).status).toBe("failed");
  await f.owner.drain(); f.owner.close();
  const restarted = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest },
    executor: new ProcessExecutor(), workArtifacts: new WorkArtifactStore(f.artifacts.root), workResources: f.workResources,
    authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await restarted.drain(); restarted.close(); });
  expect(restarted.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
  expect(restarted.get(f.task.runId).status).toBe("failed");
});


it("review regression: resource recovery advances past a full batch of unavailable arbiters", async () => {
  const f = await executingWork();
  const source = f.inspect();
  const request = String(source.prepare("SELECT request FROM workflow_work_resource_intents WHERE token=?").get(f.task.token)?.request);
  source.close();
  const db = new SqliteDatabase(":memory:");
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE workflow_work_resource_intents(token TEXT, run_id TEXT, role TEXT, broker TEXT, request TEXT, reservation TEXT, settlement TEXT, reconciled INTEGER DEFAULT 0, recovery_visits INTEGER DEFAULT 0)");
  for (let i = 0; i < 65; i++) db.prepare("INSERT INTO workflow_work_resource_intents VALUES(?,?,?,?,?,NULL,'{}',0,0)")
    .run(String(i).padStart(3, "0"), "work", "host", i < 64 ? "offline" : "healthy", request);
  let healthyLookups = 0;
  const store = {rows: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args), transaction: <T>(body: () => T) => body()};
  const {OwnerWorkResources} = await import("./work-resource-execution.js");
  const recovery = new OwnerWorkResources(store, {
    host: () => ({broker: "healthy", resource: "local"}),
    brokers: new Map([["healthy", {id: "healthy", resourceKind: () => "host" as const, acquire: () => [],
      lookup: () => {healthyLookups++; return null;}, settle: () => {throw new Error("not needed for an unacknowledged absent reservation");}}]])
  }, () => {});
  expect(recovery.reconcile(64, "064")).toBe(1);
  // Restore the healthy row to test fair global selection across object restart.
  db.prepare("UPDATE workflow_work_resource_intents SET reconciled=0,recovery_visits=0 WHERE token='064'").run();
  for (let i = 0; i < 3; i++) {
    const restarted = new OwnerWorkResources(store, Reflect.get(recovery, "options"), () => {});
    try { restarted.reconcile(); } catch { /* Offline arbiters remain unavailable. */ }
  }
  expect(healthyLookups).toBe(2);
  expect(db.prepare("SELECT count(*) n FROM workflow_work_resource_intents WHERE reconciled=0").get()?.n).toBe(64);
});


it.each([false, true])("review regression: failed-validation/cancelled receipt preserves malformed output and stopped capacity (%s)", async (cancel) => {
  const f = await executingWork();
  const launched = f.journal.claimStage(f.binding, "execution");
  await f.executor.activity(f.workflow)(f.task.input, {...f.task, signal: new AbortController().signal});
  const output = f.artifacts.stage(Buffer.from("not-json"), {owner_identity: "alice", purpose: "output", media_type: "application/json"});
  f.journal.completeStage(f.binding, {stage: "execution", effect_key: logicalStageEffectKey(f.binding.owner, f.binding.workflow_id, f.binding.activity_id, "execution"),
    attempt_id: f.task.token, state: "passed", started_at: launched.observation.observed_at, completed_at: Date.now(), result: output}, "ceased");
  const validating = f.journal.claimStage(f.binding, "validation");
  f.journal.completeStage(f.binding, {stage: "validation", effect_key: logicalStageEffectKey(f.binding.owner, f.binding.workflow_id, f.binding.activity_id, "validation"),
    attempt_id: f.task.token, state: "failed", started_at: validating.observation.observed_at, completed_at: Date.now(), result: null}, "ceased");
  if (cancel) f.journal.cancel(f.binding);
  const receipt = f.journal.publishRetainedResult(f.binding, {summary: "Output validation failed", validation: "failed", validation_failures: ["Invalid JSON"]});
  expect(receipt.outcome).toBe(cancel ? "cancelled" : "failed");
  const old = new Date(Date.now() - 3 * 86400000);
  utimesSync(f.artifacts.path(output), old, old);
  f.owner.collectWorkStaging();
  expect(f.artifacts.verify(output).toString()).toBe("not-json");
  let error: unknown;
  try { f.owner.completeWorkReceipt("owner", f.task.token, receipt); } catch (caught) { error = caught; }
  const db = f.inspect(), row = db.prepare("SELECT physical_state FROM workflow_attempts WHERE token=?").get(f.task.token);
  db.close();
  expect(error).toBeUndefined();
  expect(row?.physical_state).toBe("settled");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("alreadyAccepted");
});

it("review regression: unrelated unavailable repair does not obscure a newly completed receipt", async () => {
  const first = await executingWork(), receipt = await first.receipt();
  first.workResources.brokers.delete("local-host");
  expect(() => first.owner.completeWorkReceipt("owner", first.task.token, receipt)).toThrow(/recovery incomplete/);
  await first.owner.pump();
  const healthy = new WorkResourceBroker({ path: join(dirname(first.path), "healthy-resource.db"), broker: "healthy", limits: { local: { kind: "host" } } });
  cleanup.push(() => healthy.close());
  first.workResources.brokers.set("healthy", healthy);
  vi.spyOn(first.workResources, "host").mockReturnValue({ broker: "healthy", resource: "local" });
  const second = await executingWork(first, "healthy-second"), completed = await second.receipt();
  expect(second.owner.completeWorkReceipt("owner", second.task.token, completed)).toBe("accepted");
  expect(second.owner.completeWorkReceipt("owner", second.task.token, completed)).toBe("alreadyAccepted");
  await second.owner.pump();
  expect(second.owner.get(second.task.runId).status).toBe("completed");
  expect(healthy.inspect(second.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(first.broker.inspect(first.task.work!.resources.host_reservation!)?.state).toBe("held");
  expect(() => second.owner.reconcileWorkResources()).toThrow(/recovery incomplete/);
  expect(second.owner.workById(second.authority.namespace, second.accepted.work_id)?.facts.coordinator).toBe("completed");
});

async function supervisedWork(declaration: { mode: "none" } | { mode: "json-schema"; schema: Record<string, Json> } = { mode: "none" }, source = sourcePath,
  configuration: { budgetMs?: number; nonRepeatable?: boolean; now?: () => number } = {}) {
  const f = await fixture(configuration.now, source);
  const service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority,
    resolve: async request => { const resolved = f.resolution(request); return { ...resolved, plan: { ...resolved.plan, validation: declaration,
      execution_budget_ms: configuration.budgetMs ?? resolved.plan.execution_budget_ms,
      effect_policy: configuration.nonRepeatable ? { class: "non-repeatable" as const, max_attempts: 1 as const } : resolved.plan.effect_policy } }; } });
  const accepted = await service.submit(f.request, "alice"); await f.owner.pump();
  const { WorkProcessSupervisor } = await import("./work-process-supervisor.js");
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "supervisor.db"), installation: "owner", artifacts: f.artifacts });
  const executor = new ProcessExecutor(), errors: unknown[] = [];
  const authorize = vi.fn(async (start: NonNullable<import("./types.js").ActivityTask["work"]>) =>
    f.owner.assertWorkEffect("owner", start.attempt_id) ? f.owner.beginWork("owner", start.attempt_id) : null);
  const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts: f.artifacts, executor, authorize,
    outputIdentity: () => f.authority.namespace.identity_id, onError: error => errors.push(error) });
  cleanup.push(async () => { await supervisor.close(); journal.close(); });
  f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...f.features(), boot_identity: supervisor.bootIdentity, executors: ["process"], features: [...f.features().features, "declared-validation"] });
  const task = f.owner.claimWork("owner", "supervisor-claim")!;
  task.work = f.owner.beginWork("owner", task.token);
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, task.work![key as keyof NonNullable<typeof task.work>]])));
  return { ...f, accepted, journal, supervisor, execution: executor, task, binding, authorize, errors };
}
it.each([{ mode: "none" as const }, { mode: "json-schema" as const, schema: { type: "string" } }])("supervisor: real process and retained declared validation %j", async declaration => {
  const f = await supervisedWork(declaration), launch = vi.spyOn(f.execution, "supervisedActivity");
  await Promise.all([f.supervisor.start(f.task), f.supervisor.start(f.task)]);
  const receipt = await f.supervisor.wait(f.binding);
  expect(f.errors).toEqual([]); expect(launch).toHaveBeenCalledTimes(1);
  expect(receipt?.outcome).toBe("complete"); expect(receipt?.physical_state).toBe("ceased");
  expect(receipt?.validation).toBe(declaration.mode === "none" ? "skipped" : "passed");
  expect(f.artifacts.verify(receipt!.output!).toString()).toBe('"hello"');
  expect(f.journal.retainedStageOutput(f.binding, "execution")).toEqual(receipt?.output);
  expect(f.journal.inspect(f.binding)?.handle).toMatchObject({ kind: "process", boot_identity: f.supervisor.bootIdentity });
  f.owner.completeWorkReceipt("owner", f.task.token, receipt!); await f.owner.pump();
  expect(f.owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  await f.supervisor.start(f.task); expect(launch).toHaveBeenCalledTimes(1);
});
it("supervisor: retains main output on isolated validation failure without another main launch", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "number" } }), launch = vi.spyOn(f.execution, "supervisedActivity");
  await f.supervisor.start(f.task); const receipt = await f.supervisor.wait(f.binding);
  expect(f.errors).toEqual([]); expect(receipt?.outcome).toBe("failed"); expect(receipt?.validation).toBe("failed");
  expect(receipt?.validation_failures?.length).toBeGreaterThan(0); expect(f.artifacts.verify(receipt!.output!).toString()).toBe('"hello"');
  f.owner.completeWorkReceipt("owner", f.task.token, receipt!); await f.owner.pump(); expect(f.owner.get(f.task.runId).status).toBe("failed");
  await f.supervisor.start(f.task); expect(launch).toHaveBeenCalledTimes(1);
});
it("supervisor: withholds application input across lost handle commit acknowledgement", async () => {
  const f = await supervisedWork(), journalDb = Reflect.get(f.journal, "db") as SqliteDatabase;
  const original = journalDb.exec.bind(journalDb), commit = vi.spyOn(journalDb, "exec"); let handleCommit = false;
  commit.mockImplementation(sql => {
    if (sql === "COMMIT" && !handleCommit && journalDb.prepare("SELECT handle FROM execution_stages WHERE stage='execution'").get()?.handle) {
      handleCommit = true; original(sql); throw new Error("handle commit acknowledgement lost");
    }
    return original(sql);
  });
  await f.supervisor.start(f.task); const receipt = await f.supervisor.wait(f.binding);
  expect(receipt?.outcome).toBe("failed"); expect(receipt?.output).toBeNull(); expect(receipt?.physical_state).toBe("ceased");
  expect(f.authorize).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
});
it("supervisor: spools independently of owner lifetime and delivers after owner restart", async () => {
  const f = await supervisedWork(); let release!: () => void;
  const entered = new Promise<void>(resolve => {
    f.authorize.mockImplementationOnce(async start => f.owner.beginWork("owner", start.attempt_id)).mockImplementationOnce(async start => {
      const permit = f.owner.beginWork("owner", start.attempt_id); resolve(); await new Promise<void>(done => { release = done; }); return permit;
    });
  });
  await f.supervisor.start(f.task); await entered; await f.owner.drain(); f.owner.close(); release();
  const receipt = await f.supervisor.wait(f.binding); expect(receipt?.outcome).toBe("complete"); expect(f.errors).toEqual([]);
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest }, executor: new ProcessExecutor(),
    workArtifacts: f.artifacts, workResources: f.workResources, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.completeWorkReceipt("owner", f.task.token, receipt!)).toBe("accepted"); await owner.pump();
  expect(owner.get(f.task.runId).outcome).toEqual({ ok: true, value: "hello" });
});
it("supervisor: cancel before start fences late delivery with no execution", async () => {
  const f = await supervisedWork(), launch = vi.spyOn(f.execution, "supervisedActivity"); f.supervisor.cancel(f.binding);
  const receipt = await f.supervisor.wait(f.binding); expect(receipt?.outcome).toBe("cancelled"); expect(receipt?.physical_state).toBe("not-started");
  await f.supervisor.start(f.task); expect(launch).not.toHaveBeenCalled(); f.owner.completeWorkReceipt("owner", f.task.token, receipt!);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});
it("supervisor: deadline confirms cessation but preserves uncertain non-repeatable effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-loop-")), source = join(root, "loop.mjs"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(source, readFileSync(sourcePath, "utf8").replace("echo: async input => input", "echo: async () => { while (true) {} }"));
  const f = await supervisedWork({ mode: "none" }, source, { budgetMs: 1500, nonRepeatable: true }), launch = vi.spyOn(f.execution, "supervisedActivity");
  await f.supervisor.start(f.task); const receipt = await f.supervisor.wait(f.binding);
  expect(f.errors).toEqual([]); expect(receipt?.outcome).toBe("uncertain"); expect(receipt?.physical_state).toBe("ceased"); expect(receipt?.stages[0].state).toBe("unknown");
  f.owner.completeWorkReceipt("owner", f.task.token, receipt!); expect(f.owner.get(f.task.runId).status).toBe("blocked");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  await f.supervisor.start(f.task); expect(launch).toHaveBeenCalledTimes(1);
});
it("supervisor: policy revocation after handle commit prevents application input", async () => {
  const f = await supervisedWork(); f.authorize.mockResolvedValueOnce(f.task.work!).mockResolvedValueOnce(null);
  await f.supervisor.start(f.task); const receipt = await f.supervisor.wait(f.binding);
  expect(receipt?.physical_state).toBe("ceased"); expect(receipt?.outcome).toBe("failed"); expect(receipt?.output).toBeNull();
  expect(receipt?.failure?.code).toBe("WorkEffectForbidden"); expect(f.errors).toEqual([]);
});
it("supervisor: missing required validation fails content while retaining cessation", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "string" } }); await f.supervisor.start(f.task);
  const original = (await f.supervisor.wait(f.binding))!, { receipt_digest: _old, ...unsigned } = { ...original, validation: "skipped" as const, validation_failures: null };
  f.owner.completeWorkReceipt("owner", f.task.token, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) }); await f.owner.pump();
  expect(f.owner.get(f.task.runId).status).toBe("failed");
  const db = f.inspect(), attempt = db.prepare("SELECT physical_state,outcome FROM workflow_attempts WHERE token=?").get(f.task.token); db.close();
  expect(attempt?.physical_state).toBe("settled"); expect(JSON.parse(String(attempt?.outcome)).error.code).toBe("InvalidOutput");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});
it("supervisor: required declaration does not dispatch to an old capability set", async () => {
  const f = await fixture(), service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority,
    resolve: async request => { const resolved = f.resolution(request); return { ...resolved, plan: { ...resolved.plan, validation: { mode: "json-schema" as const, schema: { type: "string" } } } }; } });
  await service.submit(f.request, "alice"); await f.owner.pump(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    { ...f.features(), executors: [...f.features().executors], features: [...f.features().features] });
  expect(f.owner.claimWork("owner", "old-validation-worker")).toBeNull();
  const db = f.inspect(); expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0); db.close();
});
it("supervisor: refuses altered permits and freezes caller inputs before async authorization", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "string" } }), launch = vi.spyOn(f.execution, "supervisedActivity");
  await expect(f.supervisor.start({ ...f.task, type: "loop", work: { ...f.task.work!, activity_type: "loop", validation: { mode: "none" } } })).rejects.toMatchObject({ code: "WorkEffectForbidden" });
  expect(launch).not.toHaveBeenCalled(); expect(f.journal.inspect(f.binding)).toBeNull(); let release!: () => void;
  f.authorize.mockImplementationOnce(async start => { const permit = f.owner.beginWork("owner", start.attempt_id); await new Promise<void>(resolve => { release = resolve; }); return permit; });
  const accepting = f.supervisor.start(f.task); f.task.type = "loop"; f.task.input = "altered"; f.task.work!.inputs = "altered"; f.task.work!.validation = { mode: "none" };
  release(); await accepting; const receipt = await f.supervisor.wait(f.binding); expect(f.errors).toEqual([]);
  expect(receipt?.outcome).toBe("complete"); expect(receipt?.validation).toBe("passed"); expect(f.artifacts.verify(receipt!.output!).toString()).toBe('"hello"');
});
it("supervisor: real guardian death preserves occupancy and forbids replacement launch or PID stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-death-")), source = join(root, "loop.mjs"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(source, readFileSync(sourcePath, "utf8").replace("echo: async input => input", "echo: async () => { while (true) {} }"));
  const f = await supervisedWork({ mode: "none" }, source, { nonRepeatable: true });
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer supervisor-fixture") { response.writeHead(403).end(); return; }
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.end(JSON.stringify(dispatchWorkerRequest(f.owner, "owner", JSON.parse(Buffer.concat(chunks).toString())))); }
    catch { response.writeHead(409).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const configuration = join(root, "request.json"); writeFileSync(configuration, JSON.stringify({ task: f.task, journal: join(dirname(f.path), "supervisor.db"),
    artifacts: f.artifacts.root, identity: f.authority.namespace.identity_id, owner: `http://127.0.0.1:${address.port}` }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./work-supervisor-fixture.mjs", import.meta.url)), configuration], { stdio: ["ignore", "pipe", "pipe"] });
  let processPid: number | undefined; const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanup.push(async () => { child.kill("SIGKILL"); await closed; if (processPid) { try { process.kill(-processPid, "SIGKILL"); } catch { /* Disposable fixture group already absent. */ } } });
  const observed = await new Promise<import("./work-execution.js").WorkExecutionObservation>((resolve, reject) => {
    let output = "", diagnostic = ""; child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    child.once("error", reject); child.once("exit", () => reject(new Error(`supervisor exited before launch: ${diagnostic}`)));
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("\n")) {
      const message = JSON.parse(output.slice(0, output.indexOf("\n"))); if (message.phase === "started") resolve(message.observation);
    } });
  });
  expect(observed.handle?.kind).toBe("process"); if (observed.handle?.kind === "process") processPid = observed.handle.pid;
  child.kill("SIGKILL"); await closed; const replacementLaunch = vi.spyOn(f.execution, "supervisedActivity");
  await f.supervisor.start(f.task); f.supervisor.cancel(f.binding);
  expect(replacementLaunch).not.toHaveBeenCalled(); expect(await f.supervisor.wait(f.binding)).toBeNull();
  const observation = f.supervisor.inspect(f.binding).observation!; expect(observation.physical_state).toBe("stopping");
  f.owner.observeWork("owner", f.task.token, observation);
  const db = f.inspect(); db.prepare("UPDATE workflow_commands SET lease_until=0 WHERE token=?").run(f.task.token);
  db.prepare("UPDATE workflow_due SET due_at=0 WHERE run_id=?").run(f.task.runId); db.close(); f.owner.tick();
  expect(f.owner.get(f.task.runId).status).toBe("blocked"); expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
});
it("supervisor: persisted stop during online authorization fences a late permission reply", async () => {
  const f = await supervisedWork(); let release!: () => void;
  const entered = new Promise<void>(resolve => {
    f.authorize.mockImplementationOnce(async start => f.owner.beginWork("owner", start.attempt_id)).mockImplementationOnce(async start => {
      const permit = f.owner.beginWork("owner", start.attempt_id); resolve(); await new Promise<void>(done => { release = done; }); return permit;
    });
  });
  await f.supervisor.start(f.task); await entered; f.journal.cancel(f.binding); release();
  const receipt = await f.supervisor.wait(f.binding); expect(f.errors).toEqual([]);
  expect(receipt?.outcome).toBe("cancelled"); expect(receipt?.physical_state).toBe("ceased"); expect(receipt?.output).toBeNull();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt!); expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});

async function deliveryWorkerFixture() {
  const f = await fixture(), service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority,
    resolve: async request => { const resolved = f.resolution(request); return { ...resolved, plan: { ...resolved.plan, validation: { mode: "none" as const } } }; } });
  const accepted = await service.submit(f.request, "alice"); await f.owner.pump();
  const { WorkProcessSupervisor } = await import("./work-process-supervisor.js"), { WorkActivityWorker } = await import("./work-activity-worker.js");
  const journal = new ExecutorJournal({ path: join(dirname(f.path), "delivery.db"), installation: "owner", artifacts: f.artifacts });
  const client = connectWorkOwnerV3("owner", async request => dispatchWorkerRequest(f.owner, "owner", request)), executor = new ProcessExecutor(), errors: unknown[] = [];
  const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts: f.artifacts, executor,
    authorize: async start => await client.effect(start.attempt_id) ? client.begin(start.attempt_id) : null,
    outputIdentity: () => f.authority.namespace.identity_id, onError: error => errors.push(error) });
  const options = { connections: [{ owner: "owner", client }], journal, supervisor, capacity: 1,
    advertisement: { types: ["echo"], artifacts: { echo: f.workflow.digest } },
    features: () => ({ ...f.features(), boot_identity: supervisor.bootIdentity, executors: ["process" as const],
      features: [...f.features().features, "declared-validation" as const, "bounded-retries" as const] }),
    prepare: async (task: import("./types.js").ActivityTask) => { f.artifacts.verify(task.work!.source); }, onError: (error: unknown) => errors.push(error) };
  const worker = new WorkActivityWorker(options);
  cleanup.push(async () => { await worker.close(); journal.close(); });
  return { ...f, accepted, journal, client, executor, supervisor, worker, options, errors, WorkActivityWorker };
}
it.each([false, true])("work delivery: recovery-only mode cancels a retained inbox without starting application (activated=%s)", async activated => {
  const f = await deliveryWorkerFixture(), launch = vi.spyOn(f.executor, "supervisedActivity"), claim = vi.spyOn(f.client, "claim");
  await f.client.advertise({ ...f.options.advertisement, capacity: 1 }, f.options.features());
  const request = f.journal.prepareClaim("owner"), task = await f.client.claim(request); expect(task).not.toBeNull();
  f.journal.retainClaim("owner", request, task!);
  if (activated) f.journal.retainPermit("owner", await f.client.begin(task!.token));
  const reservation = f.journal.claimInbox("owner")!.permit?.resources.host_reservation;
  if (reservation) expect(f.broker.inspect(reservation)?.state).toBe("held");
  f.worker.stopClaims();
  await expect.poll(async () => { await f.worker.tick(); return f.journal.claimInbox("owner"); }).toBeNull();
  expect(f.journal.nextDelivery("owner")?.receipt).toMatchObject({ physical_state: "not-started", effect_certainty: "not-started", outcome: "cancelled", stages: [] });
  await expect.poll(async () => { await f.worker.tick(); return f.journal.pendingDeliveryCount(); }).toBe(0);
  expect(claim).toHaveBeenCalledTimes(1); expect(launch).not.toHaveBeenCalled();
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.facts).toMatchObject({ physical: "ceased", effect: "not-started" });
  if (reservation) expect(f.broker.inspect(reservation)?.state).toBe("released");
  expect(f.errors).toEqual([]);
});
it("work delivery: recovery-only mode preserves an unconfirmed claim key without making a new claim", async () => {
  const f = await deliveryWorkerFixture(), claim = vi.spyOn(f.client, "claim"), request = f.journal.prepareClaim("owner");
  f.worker.stopClaims(); await f.worker.tick();
  expect(f.journal.claimInbox("owner")).toMatchObject({ request_id: request, task: null, permit: null }); expect(claim).not.toHaveBeenCalled();
});
it("work delivery: recovery-only inbox repair preserves an existing uncertain stage and its occupancy", async () => {
  const f = await deliveryWorkerFixture(), launch = vi.spyOn(f.executor, "supervisedActivity"), cancel = vi.spyOn(f.supervisor, "cancel"), heartbeat = vi.spyOn(f.client, "heartbeat");
  await f.client.advertise({ ...f.options.advertisement, capacity: 1 }, f.options.features());
  const request = f.journal.prepareClaim("owner"), task = (await f.client.claim(request))!;
  f.journal.retainClaim("owner", request, task); const permit = await f.client.begin(task.token); f.journal.retainPermit("owner", permit);
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, permit[key as keyof typeof permit]])));
  f.journal.start(permit); f.journal.claimStage(binding, "execution"); f.worker.stopClaims();
  await expect.poll(async () => { await f.worker.tick(); return f.journal.claimInbox("owner"); }).toBeNull();
  expect(f.journal.inspect(binding)).toMatchObject({ physical_state: "unknown", cancel_requested: false, effect_certainty: "uncertain" });
  expect(f.journal.receipt(binding)).toBeNull(); expect(f.broker.inspect(permit.resources.host_reservation!)?.state).toBe("held");
  expect(cancel).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
});
it("work delivery: a real worker claims, begins, supervises, publishes and durably acknowledges one result", async () => {
  const f = await deliveryWorkerFixture(), launch = vi.spyOn(f.executor, "supervisedActivity");
  await expect.poll(async () => { await f.worker.tick(); await f.owner.pump(); return f.owner.get(f.accepted.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  await expect.poll(async () => { await f.worker.tick(); return f.journal.pendingDeliveryCount(); }).toBe(0);
  expect(launch).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
  expect(f.owner.get(f.accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" });
});
it("work delivery: a lost owner receipt acknowledgement survives worker replacement without another launch", async () => {
  const f = await deliveryWorkerFixture(), launch = vi.spyOn(f.executor, "supervisedActivity"), complete = f.client.complete.bind(f.client); let failed = false;
  vi.spyOn(f.client, "complete").mockImplementation(async (token, receipt) => { const ack = await complete(token, receipt); if (!failed) { failed = true; throw new Error("completion acknowledgement lost"); } return ack; });
  await expect.poll(async () => { await f.worker.tick(); await f.owner.pump(); return failed; }, { timeout: 15000 }).toBe(true);
  f.worker.stopClaims();
  const replacement = new f.WorkActivityWorker(f.options);
  await expect.poll(async () => { await replacement.tick(); return f.journal.pendingDeliveryCount(); }).toBe(0);
  expect(f.owner.get(f.accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" }); expect(launch).toHaveBeenCalledTimes(1);
  expect(f.errors.some(error => String(error).includes("acknowledgement lost"))).toBe(true);
});
it("work delivery: lost claim and begin acknowledgements reuse durable inbox keys", async () => {
  const f = await deliveryWorkerFixture(), claim = f.client.claim.bind(f.client), begin = f.client.begin.bind(f.client), launch = vi.spyOn(f.executor, "supervisedActivity");
  let lostClaim = false, lostBegin = false; const keys: string[] = [];
  vi.spyOn(f.client, "claim").mockImplementation(async key => { keys.push(key); const task = await claim(key); if (task && !lostClaim) { lostClaim = true; throw new Error("claim acknowledgement lost"); } return task; });
  vi.spyOn(f.client, "begin").mockImplementation(async token => { const permit = await begin(token); if (!lostBegin) { lostBegin = true; throw new Error("begin acknowledgement lost"); } return permit; });
  await expect.poll(async () => { await f.worker.tick(); await f.owner.pump(); return f.owner.get(f.accepted.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  expect(keys[0]).toBe(keys[1]); expect(launch).toHaveBeenCalledTimes(1);
  const db = f.inspect(); expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(1); db.close();
});
it("work delivery: a restarted worker restores a committed result before its receipt without rerunning main", async () => {
  const f = await supervisedWork(), launch = vi.spyOn(f.execution, "supervisedActivity");
  const original = f.journal.commitReceipt.bind(f.journal); let failed = false;
  vi.spyOn(f.journal, "commitReceipt").mockImplementation((binding, receipt) => { if (!failed) { failed = true; throw new Error("writer lost before receipt commit"); } return original(binding, receipt); });
  await f.supervisor.start(f.task); expect(await f.supervisor.wait(f.binding)).toBeNull();
  const receipt = f.supervisor.recoverReceipt(f.binding)!; expect(receipt.outcome).toBe("complete");
  expect(f.journal.pendingDeliveryCount()).toBe(1); expect(launch).toHaveBeenCalledTimes(1);
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  f.journal.acknowledgeDelivery(f.binding, receipt.receipt_digest, "accepted"); expect(f.journal.pendingDeliveryCount()).toBe(0);
});
it("work delivery: an unavailable owner cannot starve another owner's ready execution", async () => {
  const f = await deliveryWorkerFixture(); let unblock!: () => void;
  const slow = { ...f.client, advertise: async () => new Promise<void>(resolve => { unblock = resolve; }) };
  const worker = new f.WorkActivityWorker({ ...f.options, capacity: 2, connections: [{ owner: "unavailable", client: slow }, ...f.options.connections] });
  await expect.poll(async () => { await worker.tick(); await f.owner.pump(); return f.owner.get(f.accepted.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  worker.stopClaims(); unblock();
});
it("work delivery: a fresh client after lost begin acknowledgement proves no launch instead of replaying effects", async () => {
  const f = await deliveryWorkerFixture(), original = f.client.begin.bind(f.client); let failed = false;
  vi.spyOn(f.client, "begin").mockImplementation(async token => { const start = await original(token); if (!failed) { failed = true; throw new Error("begin response lost before journal start"); } return start; });
  await expect.poll(async () => { await f.worker.tick(); return failed; }).toBe(true); f.worker.stopClaims();
  const fresh = connectWorkOwnerV3("owner", async request => dispatchWorkerRequest(f.owner, "owner", request)), launch = vi.spyOn(f.executor, "supervisedActivity");
  const replacement = new f.WorkActivityWorker({ ...f.options, connections: [{ owner: "owner", client: fresh }] });
  await expect.poll(async () => { await replacement.tick(); return f.journal.pendingDeliveryCount() === 0 && f.journal.claimInbox("owner") === null; }, { timeout: 15000 }).toBe(true);
  expect(launch).not.toHaveBeenCalled();
  const db = f.inspect(); expect(db.prepare("SELECT physical_state FROM workflow_attempts LIMIT 1").get()?.physical_state).toBe("settled"); db.close();
});
it("work delivery: a rejected credential retires the owner connection before new claims", async () => {
  const f = await deliveryWorkerFixture(), { WorkerCredentialRejected } = await import("./worker-client.js");
  const advertise = vi.spyOn(f.client, "advertise").mockRejectedValue(new WorkerCredentialRejected(401)), claim = vi.spyOn(f.client, "claim");
  await f.worker.tick(); await f.worker.tick(); await f.worker.tick();
  expect(advertise).toHaveBeenCalledTimes(1); expect(claim).not.toHaveBeenCalled();
  expect(f.errors.some(error => error instanceof WorkerCredentialRejected)).toBe(true);
});
it("work delivery: the installation composition executes through a separate worker process and real transport", async () => {
  const f = await deliveryWorkerFixture(); f.worker.stopClaims();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer delivery-fixture") { response.writeHead(401).end(); return; }
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.end(JSON.stringify(dispatchWorkerRequest(f.owner, "owner", JSON.parse(Buffer.concat(chunks).toString())))); }
    catch { response.writeHead(409).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const configuration = join(dirname(f.path), "delivery-request.json");
  writeFileSync(configuration, JSON.stringify({ journal: join(dirname(f.path), "delivery.db"), artifacts: f.artifacts.root, digest: f.workflow.digest,
    owner: `http://127.0.0.1:${address.port}` }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./work-delivery-fixture.mjs", import.meta.url)), configuration], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanup.push(async () => { child.kill("SIGTERM"); await closed; });
  let diagnostic = ""; child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  await expect.poll(async () => { await f.owner.pump(); if (child.exitCode !== null) throw new Error(diagnostic); return f.owner.get(f.accepted.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  await expect.poll(() => f.journal.pendingDeliveryCount()).toBe(0);
  expect(f.owner.get(f.accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" });
  child.kill("SIGTERM"); await closed; expect(child.exitCode).toBe(0);
});
it("installed policy: fresh request-scoped policy gates real worker effects and refuses direct stale authorization", async () => {
  const f = await deliveryWorkerFixture(), { WorkPolicyDispatcher } = await import("./work-bounds.js"); let revoked = false, refreshes = 0;
  const gate = new WorkPolicyDispatcher(async () => { refreshes++; return revoked ? null : f.authority.caller_ceiling; });
  const owner = f.owner; Reflect.set(owner, "authorizeWork", gate.current);
  const client = connectWorkOwnerV3("owner", request => gate.dispatch(owner, "owner", request));
  const worker = new f.WorkActivityWorker({ ...f.options, connections: [{ owner: "owner", client }] });
  // Supervisor authorization must use the same authenticated policy dispatcher.
  Reflect.set(Reflect.get(f.supervisor, "options"), "authorize", async (start: NonNullable<import("./types.js").ActivityTask["work"]>) =>
    await client.effect(start.attempt_id) ? client.begin(start.attempt_id) : null);
  await expect.poll(async () => { await worker.tick(); await owner.pump(); return owner.get(f.accepted.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  expect(refreshes).toBeGreaterThan(0); expect(f.errors).toEqual([]);
  revoked = true;
});

it("refreshes retained delegation selections against identity bounds and tool contracts without defaults", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice"), input = accepted;
  const { createWorkScopeRefresh } = await import("./work-bounds.js");
  const tools = [{ namespace: "documents", toolName: "read", access: "read" as const, contractHash: "a".repeat(64) }];
  const traits: Record<string, { name: string; namespaces: string[]; access?: "read" | "write" }> = { caller: { name: "caller", namespaces: ["documents"], access: "read" }, task: { name: "task", namespaces: ["documents"], access: "read" } };
  let bound: import("../bounds/types.js").Bound | null = null, exists = true;
  const sources: import("./run-authorization.js").RunBoundSources = { catalog: async () => ({ tools, traits }), identity: async id => exists && id === "alice" ? { bound } : undefined,
    boundByName: async () => undefined, mayRunAs: async (principal, identity) => principal === "alice" && (identity === undefined || identity === principal), operator: () => false };
  const caller = await approveWorkflowBounds({ identity: "alice", traitNames: ["caller"], traits, tools, boundByName: sources.boundByName });
  const effective = await approveWorkflowBounds({ identity: "alice", traitNames: ["task"], traits, tools, boundByName: sources.boundByName });
  const namespace = f.authority.namespace;
  const grant = { ...f.resolution().grant, original_caller_ceiling: caller, effective_scope: effective };
  const refresh = createWorkScopeRefresh(sources);
  expect((await refresh(input, grant))?.tools).toEqual({ "documents:read": "read" });
  bound = { tools: { deny: ["*:read"] } }; expect((await refresh(input, grant))?.tools).toEqual({});
  bound = null; traits.caller = { ...traits.caller, namespaces: [] }; expect((await refresh(input, grant))?.tools).toEqual({});
  traits.caller = { ...traits.caller, namespaces: ["documents"] }; tools[0].contractHash = "b".repeat(64);
  expect((await refresh(input, grant))?.contracts?.["documents:read"]).toBe("b".repeat(64));
  exists = false; await expect(refresh(input, grant)).rejects.toThrow(/identity/);
  expect(await refresh({ ...input, namespace: { ...namespace, principal_kind: "service" } }, grant)).toBeNull();
  expect(await refresh({ ...input, namespace: { ...namespace, principal_kind: "operator" } }, grant)).toBeNull();
});

it("installed policy: active effects and heartbeat cannot borrow earlier request authorization after revocation", async () => {
  const f = await supervisedWork(), { WorkPolicyDispatcher } = await import("./work-bounds.js"); let allowed = true;
  const gate = new WorkPolicyDispatcher(async () => allowed ? f.authority.caller_ceiling : null);
  Reflect.set(f.owner, "authorizeWork", gate.current);
  const client = connectWorkOwnerV3("owner", request => gate.dispatch(f.owner, "owner", request));
  expect(await client.effect(f.task.token)).toBe(true);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/policy|authorize/);
  allowed = false; await expect(client.effect(f.task.token)).rejects.toMatchObject({ code: "WorkAuthorityUnavailable" });
  expect(await client.heartbeat(f.task.token)).toBe(false);
  f.supervisor.cancel(f.binding); const receipt = await f.supervisor.wait(f.binding);
  expect((await client.complete(f.task.token, receipt!)).status).toBe("accepted");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});
it("installed policy: a denied dispatch candidate does not starve another authorized run", async () => {
  const f = await deliveryWorkerFixture(), { WorkPolicyDispatcher } = await import("./work-bounds.js");
  const service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority,
    resolve: async request => { const resolved = f.resolution(request); return { ...resolved, plan: { ...resolved.plan, validation: { mode: "none" as const } } }; } });
  const healthy = await service.submit({ ...f.request, idempotency_key: "healthy-policy" }, "alice"); await f.owner.pump();
  const gate = new WorkPolicyDispatcher(async work => work.work_id === f.accepted.work_id ? null : f.authority.caller_ceiling);
  Reflect.set(f.owner, "authorizeWork", gate.current);
  const client = connectWorkOwnerV3("owner", request => gate.dispatch(f.owner, "owner", request));
  Reflect.set(Reflect.get(f.supervisor, "options"), "authorize", async (start: NonNullable<import("./types.js").ActivityTask["work"]>) => await client.effect(start.attempt_id) ? client.begin(start.attempt_id) : null);
  const worker = new f.WorkActivityWorker({ ...f.options, connections: [{ owner: "owner", client }] });
  await expect.poll(async () => { await worker.tick(); await f.owner.pump(); return f.owner.get(healthy.workflow_id).status; }, { timeout: 15000 }).toBe("completed");
  const db = f.inspect(); expect(db.prepare("SELECT count(*) n FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").get(f.accepted.workflow_id)?.n).toBe(0); db.close();
});
it("installed policy: pending and completed requests expose no authorization to direct owner calls", async () => {
  const f = await supervisedWork(), { WorkPolicyDispatcher } = await import("./work-bounds.js"); let release!: () => void;
  const gate = new WorkPolicyDispatcher(async (_work, _grant, worker) => {
    if (worker === "owner") { await new Promise<void>(resolve => { release = resolve; }); return f.authority.caller_ceiling; }
    return null;
  });
  Reflect.set(f.owner, "authorizeWork", gate.current);
  const client = connectWorkOwnerV3("owner", request => gate.dispatch(f.owner, "owner", request));
  const effect = client.effect(f.task.token);
  await expect.poll(() => typeof release).toBe("function");
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/policy|authorize/);
  release(); expect(await effect).toBe(true);
  expect(() => f.owner.assertWorkEffect("owner", f.task.token)).toThrow(/policy|authorize/);
});


it.each(["allow", "deny", "error"])("supervisor: drain fences a launch waiting for online authority before returning (%s)", async response => {
  const f = await supervisedWork(), launch = vi.spyOn(f.execution, "supervisedActivity");
  let entered = false, release!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.authorize.mockImplementationOnce(async start => { entered = true; await gate; if (response === "error") throw new Error("authority unavailable during shutdown"); return response === "allow" ? f.owner.beginWork("owner", start.attempt_id) : null; });
  const starting = f.supervisor.start(f.task);
  try {
    await expect.poll(() => entered).toBe(true);
    const closing = f.supervisor.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    release(); await starting; await closing;
    expect(launch).not.toHaveBeenCalled();
    const receipt = f.journal.receipt(f.binding)!;
    expect(receipt.physical_state).toBe("not-started"); expect(receipt.outcome).toBe("cancelled");
    f.owner.completeWorkReceipt("owner", f.task.token, receipt);
    expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  } finally { release(); await starting; }
});

it("work delivery: drain waits for an in-flight preparation and retains no-effect evidence before journal close", async () => {
  const f = await deliveryWorkerFixture(), launch = vi.spyOn(f.executor, "supervisedActivity");
  let entered = false, release!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new f.WorkActivityWorker({ ...f.options, prepare: async () => { entered = true; await gate; } });
  cleanup.push(() => worker.close());
  try {
    await worker.tick(); await expect.poll(() => entered).toBe(true);
    const closing = worker.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    release(); await closing;
    expect(launch).not.toHaveBeenCalled(); expect(f.journal.pendingDeliveryCount()).toBe(1);
    const delivery = f.journal.nextDelivery("owner")!;
    expect(delivery.receipt.outcome).toBe("cancelled"); expect(delivery.receipt.physical_state).toBe("not-started");
    await worker.tick(); expect(f.journal.pendingDeliveryCount()).toBe(1);
    expect(f.journal.claimInbox("owner")).toBeNull(); expect(f.errors).toEqual([]);
  } finally { release(); await worker.close(); }
});


it.each([false, true])("work result: authorizes retained output without repeating effects, including invalid JSON (%s)", async malformed => {
  const f = await executingWork(), launch = vi.spyOn(f.executor, "activity");
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  let allowed = true;
  const read = new WorkReadService({ owner: f.owner, authorize: async (credential: string) => ({
    scope: credential === "alice" ? scope : { kind: "identity" as const, installation: "owner", identity_id: "other" }, controls: allowed ? ["inspect" as const, "result" as const] : ["inspect" as const] }) });
  expect((await read.result(f.accepted.work_id, "alice")).status).toBe("pending");
  const receipt = await f.receipt(malformed ? () => ({ bytes: Buffer.from("not-json"), media: "application/json" }) : undefined);
  f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  const before = f.owner.workById(f.authority.namespace, f.accepted.work_id)!.revision;
  const result = await read.result(f.accepted.work_id, "alice");
  expect(result.status).toBe("available"); expect(result.retained_output?.reference).toEqual(receipt.output);
  expect(result.outcome?.ok).toBe(!malformed);
  if (malformed) expect(result.retained_output?.invalid_reason).toMatch(/valid bounded finite JSON/);
  else expect(result.retained_output?.value).toBe("hello");
  await expect(read.result(f.accepted.work_id, "other")).rejects.toMatchObject({ code: "WorkNotFound" });
  allowed = false; await expect(read.result(f.accepted.work_id, "alice")).rejects.toMatchObject({ code: "Forbidden" });
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)!.revision).toBe(before); expect(launch).toHaveBeenCalledTimes(1);
});

it("work result: keeps failed validation output distinct from the failed workflow outcome", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "integer" } });
  await f.supervisor.start(f.task); const receipt = (await f.supervisor.wait(f.binding))!;
  f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  const result = f.owner.workResult({ kind: "namespace", namespace: f.authority.namespace }, f.accepted.work_id);
  expect(result.outcome?.ok).toBe(false); expect(result.retained_output?.value).toBe("hello");
  expect(result.retained_output?.validation).toBe("failed"); expect(result.retained_output?.validation_failures?.length).toBeGreaterThan(0);
});

it("work stop: scopes, revisions and durable acknowledgement survive restart without another mutation", async () => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const scope = { kind: "namespace" as const, namespace: f.authority.namespace };
  let allowed = true;
  const control = new WorkControlService({ owner: f.owner, authorize: async (credential: string) => ({ actor: credential,
    scope: credential === "alice" ? scope : { kind: "identity" as const, installation: "owner", identity_id: "other" }, controls: allowed ? ["stop" as const] : [] }) });
  const request = { request_id: "443b81b7-3017-4327-a58e-a1d1bbd093d4", expected_revision: accepted.revision };
  await expect(control.stop(accepted.work_id, request, "other")).rejects.toMatchObject({ code: "WorkNotFound" });
  await expect(control.stop(accepted.work_id, { ...request, expected_revision: accepted.revision + 1 }, "alice")).rejects.toMatchObject({ code: "WorkRevisionConflict" });
  const ack = await control.stop(accepted.work_id, request, "alice");
  expect(ack.stop_requested).toBe(true); expect(f.owner.workById(f.authority.namespace, accepted.work_id)?.facts.coordinator).toBe("cancelled");
  expect(await control.stop(accepted.work_id, request, "alice")).toEqual(ack);
  await expect(control.stop(accepted.work_id, { ...request, expected_revision: ack.applied_revision }, "alice")).rejects.toMatchObject({ code: "WorkControlConflict" });
  allowed = false; await expect(control.stop(accepted.work_id, request, "alice")).rejects.toMatchObject({ code: "Forbidden" });
  await f.owner.drain(); f.owner.close();
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], activityArtifacts: { echo: f.workflow.digest }, executor: new ProcessExecutor(), workArtifacts: f.artifacts, workResources: f.workResources });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.stopWork(accepted.work_id, request, "alice")).toEqual(ack);
  expect(owner.history(accepted.workflow_id).filter(event => event.type === "WorkStopRequested")).toHaveLength(1);
});

it.each([-16000, 16000])("work stop: a live process retains capacity through an owner clock change of %i ms until cessation proof", async offset => {
  const root = mkdtempSync(join(tmpdir(), "work-stop-loop-")), source = join(root, "loop.mjs"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(source, readFileSync(sourcePath, "utf8").replace("echo: async input => input", "echo: async () => { while (true) {} }"));
  let adjustment = 0;
  const f = await supervisedWork({ mode: "none" }, source, { budgetMs: 10000, nonRepeatable: true, now: () => Date.now() + adjustment });
  await f.supervisor.start(f.task);
  await expect.poll(() => f.journal.inspect(f.binding)?.physical_state).toBe("running");
  f.owner.observeWork("owner", f.task.token, f.journal.inspect(f.binding)!);
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(work.reason?.code).not.toBe("ExecutionUncertain");
  f.owner.stopWork(work.work_id, { request_id: "7215d183-e0fb-45bb-b9f8-0e130669a3da", expected_revision: work.revision }, "alice");
  expect(projectWorkState(f.owner.workById(f.authority.namespace, work.work_id)!.facts).state).toBe("stopping");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
  expect(f.owner.inspectWork("owner", f.task.token).stop_requested).toBe(true);
  adjustment = offset;
  f.owner.tick();
  expect(projectWorkState(f.owner.workById(f.authority.namespace, work.work_id)!.facts).state).toBe("needs-attention");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
  f.supervisor.cancel(f.binding); const receipt = (await f.supervisor.wait(f.binding))!;
  expect(receipt.physical_state).toBe("ceased"); f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.get(f.task.runId).status).toBe("cancelled");
});

async function validationCrash(schema: Record<string, Json> = { type: "string" }) {
  const f = await supervisedWork({ mode: "json-schema", schema });
  const client = connectWorkOwnerV3("owner", async request => dispatchWorkerRequest(f.owner, "owner", request));
  await client.inspect(f.task.token);
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer supervisor-fixture") { response.writeHead(403).end(); return; }
    try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { start: import("./work-execution.js").WorkExecutionStart };
      response.end(JSON.stringify(await client.effect(body.start.attempt_id) ? await client.begin(body.start.attempt_id) : null)); }
    catch { response.writeHead(409).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const root = dirname(f.path), config = join(root, "validation-crash.json");
  writeFileSync(config, JSON.stringify({ task: f.task, journal: join(root, "supervisor.db"), artifacts: f.artifacts.root, identity: f.authority.namespace.identity_id,
    owner: `http://127.0.0.1:${(server.address() as { port: number }).port}`, crashBeforeValidation: true, authorizationOnly: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./work-supervisor-fixture.mjs", import.meta.url)), config], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = ""; child.stderr.on("data", data => { diagnostic += String(data); });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  cleanup.push(async () => { child.kill("SIGKILL"); await closed; });
  expect(await closed, diagnostic).toEqual({ code: null, signal: "SIGKILL" });
  expect(f.journal.stageReceipts(f.binding).map(stage => [stage.stage, stage.state])).toEqual([["execution", "passed"]]);
  expect(f.journal.inspect(f.binding)?.physical_state).toBe("ceased");
  expect(f.journal.receipt(f.binding)).toBeNull();
  return { ...f, client };
}

it.each(["string", "integer"])("stage recovery: a killed guardian resumes only the declared validator (%s)", async type => {
  const f = await validationCrash({ type }), main = vi.spyOn(f.execution, "supervisedActivity"), validation = vi.spyOn(f.execution, "supervisedValidation");
  expect(f.supervisor.recoverReceipt(f.binding)).toBeNull();
  await Promise.all([f.supervisor.resumeValidation(f.binding), f.supervisor.resumeValidation(f.binding)]);
  const receipt = (await f.supervisor.wait(f.binding))!;
  expect(f.errors).toEqual([]); expect(main).not.toHaveBeenCalled(); expect(validation).toHaveBeenCalledTimes(1);
  expect(receipt.validation).toBe(type === "string" ? "passed" : "failed"); expect(receipt.output).toEqual(f.journal.stageReceipts(f.binding)[0].result);
  f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  expect(f.owner.get(f.task.runId).status).toBe(type === "string" ? "completed" : "failed");
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});

it("stage recovery: an expired missing validator records a timeout and retains proven cessation/output", async () => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation"), main = vi.spyOn(f.execution, "supervisedActivity");
  let receipt: import("./work-execution.js").WorkExecutionReceipt;
  const clock = vi.spyOn(Date, "now").mockReturnValue(f.binding.deadline + 1);
  try { receipt = f.supervisor.recoverReceipt(f.binding)!; expect(await f.supervisor.resumeValidation(f.binding)).toBeNull(); }
  finally { clock.mockRestore(); }
  expect(receipt!.outcome).toBe("timed-out"); expect(receipt!.validation).toBe("failed"); expect(receipt!.validation_failures).toEqual(["Required validation did not complete before stop or deadline."]);
  expect(main).not.toHaveBeenCalled(); expect(validation).not.toHaveBeenCalled();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt!);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.artifacts.verify(receipt!.output!).toString()).toBe('"hello"');
});

it("stage recovery: stop finalizes known main output without starting validation", async () => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  f.owner.cancel(f.task.runId); f.supervisor.cancel(f.binding);
  const receipt = f.supervisor.recoverReceipt(f.binding)!;
  expect(receipt.outcome).toBe("cancelled"); expect(receipt.validation).toBe("failed");
  expect(await f.supervisor.resumeValidation(f.binding)).toBeNull(); expect(validation).not.toHaveBeenCalled();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.owner.get(f.task.runId).status).toBe("cancelled");
});

it("stage recovery: a fresh fenced worker cannot reuse root authority or rerun an unresolved validator", async () => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  const fresh = connectWorkOwnerV3("owner", async request => dispatchWorkerRequest(f.owner, "owner", request));
  await fresh.inspect(f.task.token);
  f.authorize.mockImplementation(async start => await fresh.effect(start.attempt_id) ? fresh.begin(start.attempt_id) : null);
  expect(await f.supervisor.resumeValidation(f.binding)).toBeNull(); expect(validation).not.toHaveBeenCalled();
  expect(f.owner.workById(f.authority.namespace, f.accepted.work_id)?.facts.coordinator).toBe("blocked");
  f.journal.claimStage(f.binding, "validation");
  const clock = vi.spyOn(Date, "now").mockReturnValue(f.binding.deadline + 1);
  try { expect(f.supervisor.recoverReceipt(f.binding)).toBeNull(); expect(await f.supervisor.resumeValidation(f.binding)).toBeNull(); }
  finally { clock.mockRestore(); }
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
  expect(f.journal.inspect(f.binding)?.physical_state).toBe("unknown");
});

it("stage recovery: the worker maintenance loop validates known retained output without another main launch", async () => {
  const f = await validationCrash(), { WorkActivityWorker } = await import("./work-activity-worker.js");
  f.authorize.mockImplementation(async start => await f.client.effect(start.attempt_id) ? f.client.begin(start.attempt_id) : null);
  const main = vi.spyOn(f.execution, "supervisedActivity"), validation = vi.spyOn(f.execution, "supervisedValidation");
  const worker = new WorkActivityWorker({ journal: f.journal, supervisor: f.supervisor, capacity: 1,
    connections: [{ owner: "owner", client: f.client }], advertisement: { types: ["echo"], artifacts: { echo: f.workflow.digest } },
    features: () => ({ ...f.features(), boot_identity: f.supervisor.bootIdentity, executors: ["process"], features: [...f.features().features, "declared-validation"] }),
    prepare: async () => { throw new Error("Recovery must not prepare or launch another main."); }, onError: error => f.errors.push(error) });
  cleanup.push(() => worker.close());
  await expect.poll(async () => { await worker.tick(); await f.owner.pump(); return f.owner.get(f.task.runId).status; }, { timeout: 15000 }).toBe("completed");
  await expect.poll(async () => { await worker.tick(); return f.journal.pendingDeliveryCount(); }).toBe(0);
  expect(main).not.toHaveBeenCalled(); expect(validation).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
});

it("stage recovery: retained validation failure details survive a lost receipt commit", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "integer" } }), main = vi.spyOn(f.execution, "supervisedActivity"), validation = vi.spyOn(f.execution, "supervisedValidation");
  const original = f.journal.commitReceipt.bind(f.journal); let attempted: import("./work-execution.js").WorkExecutionReceipt | undefined;
  vi.spyOn(f.journal, "commitReceipt").mockImplementation((binding, receipt) => { if (!attempted) { attempted = receipt; throw new Error("receipt commit interrupted"); } return original(binding, receipt); });
  await f.supervisor.start(f.task); expect(await f.supervisor.wait(f.binding)).toBeNull();
  const recovered = f.supervisor.recoverReceipt(f.binding)!;
  expect(recovered.validation).toBe("failed"); expect(recovered.validation_failures).toEqual(attempted!.validation_failures);
  expect(main).toHaveBeenCalledTimes(1); expect(validation).toHaveBeenCalledTimes(1);
  f.owner.completeWorkReceipt("owner", f.task.token, recovered);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});

it.each(["revoked", "altered"])("stage recovery: fresh full authority is required for validation (%s)", async mode => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  if (mode === "revoked") {
    f.denyEffects(); await expect(f.supervisor.resumeValidation(f.binding)).rejects.toMatchObject({ code: "WorkAuthorityUnavailable" });
  } else {
    f.authorize.mockResolvedValueOnce({ ...f.task.work!, deadline: f.task.work!.deadline + 1 });
    expect(await f.supervisor.resumeValidation(f.binding)).toBeNull();
  }
  expect(validation).not.toHaveBeenCalled(); expect(f.journal.stageReceipts(f.binding)).toHaveLength(1);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
});

it("stage recovery: corrupt retained bytes cannot authorize validation or manufacture stop proof", async () => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  const output = f.journal.stageReceipts(f.binding)[0].result!;
  writeFileSync(f.artifacts.path(output), "corrupted durable bytes");
  await expect(f.supervisor.resumeValidation(f.binding)).rejects.toThrow();
  expect(() => f.supervisor.recoverReceipt(f.binding)).toThrow(); expect(validation).not.toHaveBeenCalled();
  expect(f.journal.receipt(f.binding)).toBeNull(); expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
});

it.each(["allow", "deny", "error"])("stage recovery: drain fences delayed validation authority (%s)", async response => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  let entered = false, release!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.authorize.mockImplementationOnce(async start => { entered = true; await gate; if (response === "error") throw new Error("authority unavailable"); return response === "allow" ? f.owner.beginWork("owner", start.attempt_id) : null; });
  const resuming = f.supervisor.resumeValidation(f.binding);
  try {
    await expect.poll(() => entered).toBe(true);
    const closing = f.supervisor.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    release(); await resuming; await closing;
    const receipt = f.journal.receipt(f.binding)!; expect(receipt.outcome).toBe("cancelled"); expect(receipt.validation).toBe("failed");
    expect(validation).not.toHaveBeenCalled(); f.owner.completeWorkReceipt("owner", f.task.token, receipt);
    expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  } finally { release(); await resuming; }
});

it("stage recovery: malformed digest-valid main output fails content without stranding proven cessation", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "string" } });
  const stage = f.artifacts.stage.bind(f.artifacts), claim = f.journal.claimStage.bind(f.journal), validation = vi.spyOn(f.execution, "supervisedValidation");
  vi.spyOn(f.artifacts, "stage").mockImplementation((bytes, metadata) => stage(metadata.purpose === "output" ? Buffer.from("not-json") : bytes, metadata));
  vi.spyOn(f.journal, "claimStage").mockImplementation((binding, kind) => { if (kind === "validation") throw new Error("guardian boundary interrupted"); return claim(binding, kind); });
  await f.supervisor.start(f.task); expect(await f.supervisor.wait(f.binding)).toBeNull();
  const receipt = f.supervisor.recoverReceipt(f.binding)!;
  expect(receipt.outcome).toBe("failed"); expect(receipt.validation).toBe("failed"); expect(receipt.physical_state).toBe("ceased");
  expect(receipt.validation_failures).toEqual(["Retained output is not valid bounded finite JSON."]); expect(validation).not.toHaveBeenCalled();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  expect(f.artifacts.verify(receipt.output!).toString()).toBe("not-json");
});

it("stage recovery: a fenced replacement worker publishes retained cancellation and releases only proven stopped capacity", async () => {
  const f = await validationCrash(), { WorkActivityWorker } = await import("./work-activity-worker.js");
  const fresh = connectWorkOwnerV3("owner", async request => dispatchWorkerRequest(f.owner, "owner", request));
  await fresh.inspect(f.task.token);
  const main = vi.spyOn(f.execution, "supervisedActivity"), validation = vi.spyOn(f.execution, "supervisedValidation");
  const worker = new WorkActivityWorker({ journal: f.journal, supervisor: f.supervisor, capacity: 1,
    connections: [{ owner: "owner", client: fresh }], advertisement: { types: ["echo"], artifacts: { echo: f.workflow.digest } },
    features: () => ({ ...f.features(), boot_identity: f.supervisor.bootIdentity, executors: ["process"], features: [...f.features().features, "declared-validation"] }),
    prepare: async () => { throw new Error("No replacement main is permitted."); }, onError: error => f.errors.push(error) });
  cleanup.push(() => worker.close());
  await expect.poll(async () => { await worker.tick(); return f.journal.receipt(f.binding)?.outcome; }).toBe("cancelled");
  await expect.poll(async () => { await worker.tick(); return f.journal.pendingDeliveryCount(); }).toBe(0);
  expect(main).not.toHaveBeenCalled(); expect(validation).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  const work = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(work.facts.coordinator).toBe("blocked"); expect(work.facts.physical).toBe("ceased"); expect(work.reason?.code).toBe("LateExecutionEvidence");
  expect(f.artifacts.verify(f.journal.receipt(f.binding)!.output!).toString()).toBe('"hello"');
});

it("stage recovery: an explicitly skipped required validator cannot become completion or strand cessation", async () => {
  const f = await validationCrash(), validation = vi.spyOn(f.execution, "supervisedValidation");
  const claim = f.journal.claimStage(f.binding, "validation");
  f.journal.completeStage(f.binding, { stage: "validation", effect_key: logicalStageEffectKey(f.binding.owner, f.binding.workflow_id, f.binding.activity_id, "validation"),
    attempt_id: f.task.token, state: "skipped", started_at: claim.observation.observed_at, completed_at: Date.now(), result: null }, "not-started");
  const receipt = f.supervisor.recoverReceipt(f.binding)!;
  expect(receipt.outcome).toBe("failed"); expect(receipt.validation).toBe("failed"); expect(receipt.validation_failures).toEqual(["Required validation was skipped without a passing verdict."]);
  expect(await f.supervisor.resumeValidation(f.binding)).toBeNull(); expect(validation).not.toHaveBeenCalled();
  f.owner.completeWorkReceipt("owner", f.task.token, receipt);
  expect(f.broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
});

it("stage recovery: legacy publication metadata after the deadline does not invalidate completed effect stages", async () => {
  const f = await supervisedWork();
  const original = f.journal.commitReceipt.bind(f.journal); let interrupted = false;
  vi.spyOn(f.journal, "commitReceipt").mockImplementation((binding, receipt) => { if (!interrupted) { interrupted = true; throw new Error("receipt acknowledgement lost before commit"); } return original(binding, receipt); });
  await f.supervisor.start(f.task); expect(await f.supervisor.wait(f.binding)).toBeNull();
  const at = f.binding.deadline + 1, publication = { stage: "publication", attempt_id: f.task.token,
    effect_key: logicalStageEffectKey(f.binding.owner, f.binding.workflow_id, f.binding.activity_id, "publication"), state: "passed", started_at: at, completed_at: at, result: null };
  const db = Reflect.get(f.journal, "db") as SqliteDatabase;
  db.prepare("INSERT INTO execution_stages(owner,workflow,activity,stage,effect_key,intent_at,handle,receipt) SELECT owner,workflow,activity,'publication',?,?,NULL,? FROM execution_stages WHERE stage='execution'")
    .run(publication.effect_key, at, JSON.stringify(publication));
  const clock = vi.spyOn(Date, "now").mockReturnValue(at + 1);
  try { const recovered = f.supervisor.recoverReceipt(f.binding)!; expect(recovered.outcome).toBe("complete"); expect(recovered.stages).toHaveLength(2); }
  finally { clock.mockRestore(); }
});


it("reconciliation evidence is scoped, verified, bounded metadata with immutable actor audit", async () => {
  const f = await lateWork();
  let canReview = true;
  const reads = new WorkReadService({ owner: f.owner, authorize: async () => ({ scope: { kind: "installation" as const, installation: "owner" }, controls: canReview ? ["inspect" as const, "reconcile" as const] : ["inspect" as const] }) });
  const reviewed = await reads.inspect(f.accepted.work_id, "operator");
  expect(reviewed.can_review_reconciliation).toBe(true); expect(reviewed.allowed_actions).toContain("reconcile");
  canReview = false;
  const revoked = await reads.inspect(f.accepted.work_id, "operator");
  expect(revoked.revision).toBe(reviewed.revision); expect(revoked.can_review_reconciliation).toBe(false); expect(revoked.allowed_actions).not.toContain("reconcile");
  await expect(f.control.evidence(f.accepted.work_id, "reader")).rejects.toMatchObject({ status: 403 });
  const restricted = new WorkControlService({ owner: f.owner, authorize: async () => ({ actor: "other", scope: { kind: "identity" as const, installation: "owner", identity_id: "other" }, controls: ["reconcile" as const] }) });
  await expect(restricted.evidence(f.accepted.work_id, "other")).rejects.toMatchObject({ status: 404 });
  const before = await f.control.evidence(f.accepted.work_id, "operator");
  expect(before).toMatchObject({ work_id: f.accepted.work_id, revision: f.request.expected_revision, truncated: false, audit: [] });
  expect(before.receipts).toHaveLength(1); expect(before.receipts[0]).toMatchObject({ attempt_id: f.task.token, receipt_digest: f.receipt.receipt_digest, physical_state: "ceased" });
  expect(before.receipts[0]).not.toHaveProperty("value"); expect(before.receipts[0]).not.toHaveProperty("output");
  const ack = await f.control.reconcile(f.accepted.work_id, f.request, "operator");
  const after = await f.control.evidence(f.accepted.work_id, "operator");
  expect(after.audit).toHaveLength(1); expect(after.audit[0]).toMatchObject({ request_id: f.request.request_id, acknowledgement: ack, evidence: { actor: "operator-uuid", reason: f.request.reason, residualRisk: f.request.residual_risk } });
  writeFileSync(f.artifacts.path(f.receipt.output!), "corrupted after receipt retention");
  await expect(f.control.evidence(f.accepted.work_id, "operator")).rejects.toThrow();
});

async function recoveryInventory(f: Pick<Awaited<ReturnType<typeof executingWork>>, "path" | "owner" | "request" | "authority" | "resolution" | "artifacts">, journalFile = "executor.db") {
  const { WorkDelegationIssuer, WorkDelegationVerifier } = await import("./work-delegation.js");
  const key = { id: "key", secret: "fixture-only-work-backup-signing-key", not_before: 0, not_after: Date.now() + 3600000 };
  const issuer = new WorkDelegationIssuer({ path: join(dirname(f.path), "issuer.db"), issuer: "fixture-issuer", signingKey: () => key });
  cleanup.push(() => issuer.close());
  const prepared = issuer.prepare({ ...f.request, idempotency_key: "backup-authenticated-issuer" }, f.authority, { kind: "session", definition_owner_session: "session", background_parent: false });
  const verifier = new WorkDelegationVerifier({ installation: "owner", keys: name => name === "fixture-issuer" ? [key] : [], authorizeIssuer: record => record.issuer === "fixture-issuer" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity", currentPolicy: async () => f.authority.caller_ceiling });
  const service = new WorkAdmissionService({ owner: f.owner, authenticate: verifier.authenticate.bind(verifier), resolve: async request => f.resolution(request) });
  await service.submitWithReceipt(prepared.request, issuer.issue(prepared.request, f.authority));
  const { workRecoveryInventorySchema } = await import("./work-recovery.js");
  const inventory = workRecoveryInventorySchema.parse({ version: 1, components: [
    { id: "executor", role: "executor", identity: "owner", path: join(dirname(f.path), journalFile), artifact_root: f.artifacts.root, workers: ["owner"] },
    { id: "broker", role: "broker", identity: "local-host", path: join(dirname(f.path), "resource.db") },
    { id: "issuer", role: "issuer", identity: "fixture-issuer", path: join(dirname(f.path), "issuer.db") },
  ] });
  return { inventory, issuer, prepared };
}
it("coordinated recovery: preserves an undelivered real result, issuer key binding, held capacity and exact journal delivery", async () => {
  const f = await executingWork(), receipt = await f.receipt(), { inventory, prepared } = await recoveryInventory(f);
  rmSync(f.artifacts.path(receipt.output!)); // Only the durable executor pin remains before owner delivery.
  const claim = f.journal.prepareClaim("owner"); f.journal.retainClaim("owner", claim, f.task); f.journal.retainPermit("owner", f.task.work!);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(dirname(f.path), "coordinated-snapshot"), destination = join(dirname(f.path), "coordinated-restore");
  const manifest = await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root, inventory);
  expect(manifest.workRecovery?.components).toHaveLength(3); expect(manifest.createdAt).toBe(manifest.workRecovery?.captured_at);
  expect(manifest.workRecovery?.external_credentials).toEqual(["fixture-issuer"]);
  await expect(restoreWorkflows(snapshot, destination, "owner", true)).rejects.toThrow(/executor.*fenced/); expect(existsSync(destination)).toBe(false);
  await f.owner.drain(); f.owner.close(); f.journal.close(); f.broker.close();
  await restoreWorkflows(snapshot, destination, "owner", true, true);
  const artifacts = new WorkArtifactStore(join(destination, "work-artifacts"));
  const executorArtifacts = new WorkArtifactStore(join(destination, "work-recovery", "executor-artifacts"));
  const journal = new ExecutorJournal({ path: join(destination, "work-recovery", "executor.db"), installation: "owner", artifacts: executorArtifacts }); cleanup.push(() => journal.close());
  expect(journal.receipt(f.binding)).toEqual(receipt); expect(journal.claimInbox("owner")?.permit).toEqual(f.task.work);
  expect(journal.claimStage(f.binding, "execution").launch).toBe(false); expect(journal.pendingDeliveryCount()).toBe(1);
  expect(artifacts.verify(receipt.output!).toString()).toBe('"hello"'); expect(executorArtifacts.verify(receipt.output!).toString()).toBe('"hello"');
  const broker = new WorkResourceBroker({ path: join(destination, "work-recovery", "broker.db"), broker: "local-host", limits: { local: { kind: "host" } } }); cleanup.push(() => broker.close());
  expect(broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
  const restoredArtifact = { ...f.workflow, path: join(destination, `${f.workflow.digest}.mjs`) };
  rmSync(f.workflow.path);
  const owner = new WorkflowOwner({ id: "owner", path: join(destination, "workflows.db"), artifacts: [restoredArtifact], activityArtifacts: { echo: f.workflow.digest }, executor: new ProcessExecutor(), workArtifacts: artifacts,
    workResources: { host: () => ({ broker: "local-host", resource: "local" }), brokers: new Map([["local-host", broker]]) }, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("stale"); expect(broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("released");
  const work = owner.workById(f.authority.namespace, f.accepted.work_id)!;
  owner.reconcileWorkReceipt(work.work_id, { request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", expected_revision: work.revision, attempt_id: f.task.token, receipt_digest: receipt.receipt_digest,
    reason: "All old effect paths fenced; verified retained journal receipt.", residual_risk: "No repeated activity; retain original effect evidence." }, "operator");
  await owner.pump(); expect(owner.get(work.workflow_id).outcome).toEqual({ ok: true, value: "hello" });
  const { WorkDelegationIssuer } = await import("./work-delegation.js");
  const issuer = new WorkDelegationIssuer({ path: join(destination, "work-recovery", "issuer.db"), issuer: "fixture-issuer", signingKey: () => ({ id: "replacement", secret: "fixture-only-restored-rotated-signing-key", not_before: 0, not_after: Date.now() + 3600000 }) }); cleanup.push(() => issuer.close());
  expect(issuer.prepare(prepared.request, f.authority, { kind: "session", definition_owner_session: "session", background_parent: false })).toEqual(prepared);
});
it.each(["identity", "version", "missing-broker", "missing-worker", "missing-issuer", "missing-attempt", "corrupt-output"])("coordinated recovery: refuses incomplete or unverifiable snapshots (%s)", async fault => {
  const f = await executingWork(), receipt = await f.receipt(), { inventory } = await recoveryInventory(f);
  if (fault === "identity") inventory.components[0].identity = "another-installation";
  if (fault === "missing-attempt") { const path = join(dirname(f.path), "empty-executor.db"), empty = new ExecutorJournal({ path, installation: "owner", artifacts: f.artifacts }); empty.close(); inventory.components[0].path = path; }
  if (fault === "missing-issuer") inventory.components = inventory.components.filter(entry => entry.role !== "issuer");
  if (fault === "missing-broker") inventory.components = inventory.components.filter(entry => entry.role !== "broker");
  if (fault === "missing-worker" && inventory.components[0].role === "executor") inventory.components[0].workers = ["unrelated"];
  if (fault === "version") { const db = new SqliteDatabase(join(dirname(f.path), "executor.db")); try { db.exec("PRAGMA user_version=99"); } finally { db.close(); } }
  if (fault === "corrupt-output") writeFileSync(f.artifacts.path(receipt.output!), "bad");
  const { snapshotWorkflows } = await import("./recovery.js"); const target = join(dirname(f.path), "rejected-snapshot");
  await expect(snapshotWorkflows(f.path, target, "owner", [f.workflow], f.artifacts.root, inventory)).rejects.toThrow(); expect(existsSync(target)).toBe(false);
});
it.each(["database", "output", "manifest-path", "unverified-sidecar"])("coordinated recovery: rejects corrupt or redirected restore evidence (%s)", async fault => {
  const f = await executingWork(), receipt = await f.receipt(), { inventory } = await recoveryInventory(f);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js"); const snapshot = join(dirname(f.path), "restore-corrupt-snapshot"), target = join(dirname(f.path), "restore-corrupt-target");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root, inventory);
  if (fault === "database") writeFileSync(join(snapshot, "work-recovery", "broker.db"), "corrupt");
  if (fault === "unverified-sidecar") writeFileSync(join(snapshot, "work-recovery", "broker.db-wal"), "unverified WAL bytes");
  if (fault === "output") { const store = new WorkArtifactStore(join(snapshot, "work-recovery", "executor-artifacts")); writeFileSync(store.path(receipt.output!), "corrupt"); }
  if (fault === "manifest-path") { const path = join(snapshot, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8")); manifest.workRecovery.components[0].id = "../../outside"; writeFileSync(path, JSON.stringify(manifest)); }
  await expect(restoreWorkflows(snapshot, target, "owner", true, true)).rejects.toThrow(); expect(existsSync(target)).toBe(false);
});


it("coordinated recovery: a lost guardian and unresolved validation remain unlaunchable with capacity held", async () => {
  const f = await validationCrash(), { inventory } = await recoveryInventory(f, "supervisor.db");
  const unresolved = f.journal.claimStage(f.binding, "validation"); f.owner.observeWork("owner", f.task.token, unresolved.observation);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js"); const snapshot = join(dirname(f.path), "orphan-snapshot"), target = join(dirname(f.path), "orphan-restore");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root, inventory);
  await f.supervisor.close(); f.journal.close(); await f.owner.drain(); f.owner.close(); f.broker.close();
  await restoreWorkflows(snapshot, target, "owner", true, true);
  const artifacts = new WorkArtifactStore(join(target, "work-recovery", "executor-artifacts")), journal = new ExecutorJournal({ path: join(target, "work-recovery", "executor.db"), installation: "owner", artifacts }); cleanup.push(() => journal.close());
  expect(journal.inspect(f.binding)).toMatchObject({ physical_state: "unknown", effect_certainty: "uncertain" });
  const { WorkProcessSupervisor } = await import("./work-process-supervisor.js"); const executor = new ProcessExecutor(), launch = vi.spyOn(executor, "supervisedActivity"), validation = vi.spyOn(executor, "supervisedValidation"), authorize = vi.fn(async () => f.task.work!);
  const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts, executor, authorize, outputIdentity: () => f.authority.namespace.identity_id }); cleanup.push(() => supervisor.close());
  await supervisor.start(f.task); expect(await supervisor.resumeValidation(f.binding)).toBeNull(); expect(supervisor.recoverReceipt(f.binding)).toBeNull();
  expect(launch).not.toHaveBeenCalled(); expect(validation).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  const broker = new WorkResourceBroker({ path: join(target, "work-recovery", "broker.db"), broker: "local-host", limits: { local: { kind: "host" } } }); cleanup.push(() => broker.close());
  expect(broker.inspect(f.task.work!.resources.host_reservation!)?.state).toBe("held");
});
it("coordinated recovery: keeps failed isolated validation and raw output through a complete bundle", async () => {
  const f = await supervisedWork({ mode: "json-schema", schema: { type: "integer" } }); await f.supervisor.start(f.task); const receipt = (await f.supervisor.wait(f.binding))!;
  expect(receipt.validation).toBe("failed"); const { inventory } = await recoveryInventory(f, "supervisor.db");
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js"); const snapshot = join(dirname(f.path), "invalid-snapshot"), target = join(dirname(f.path), "invalid-restore");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root, inventory); await f.supervisor.close(); f.journal.close(); await f.owner.drain(); f.owner.close(); f.broker.close();
  await restoreWorkflows(snapshot, target, "owner", true, true);
  const artifacts = new WorkArtifactStore(join(target, "work-recovery", "executor-artifacts")), journal = new ExecutorJournal({ path: join(target, "work-recovery", "executor.db"), installation: "owner", artifacts }); cleanup.push(() => journal.close());
  expect(journal.receipt(f.binding)).toEqual(receipt); expect(artifacts.verify(receipt.output!).toString()).toBe('"hello"');
  expect(journal.claimStage(f.binding, "execution").launch).toBe(false); expect(journal.claimStage(f.binding, "validation").launch).toBe(false);
});
it("coordinated recovery: standalone maintenance CLI snapshots and requires both fences for restore", async () => {
  const f = await executingWork(); await f.receipt(); const { inventory } = await recoveryInventory(f);
  const root = dirname(f.path), snapshot = join(root, "cli-snapshot"), target = join(root, "cli-restore"), manifest = join(root, "artifact-manifest.json"), config = join(root, "recovery-inventory.json");
  writeFileSync(manifest, JSON.stringify({ workflows: [{ path: f.workflow.path, type: f.workflow.type, version: f.workflow.version }], activities: [] })); writeFileSync(config, JSON.stringify(inventory));
  const call = (args: string[]) => new Promise<{ code: number | null; output: string; error: string }>(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./maintenance-cli.ts", import.meta.url)), ...args], { stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = "";
    child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { error += String(data); }); child.once("close", code => resolve({ code, output, error }));
  });
  const copied = await call(["snapshot", "--owner", "owner", "--database", f.path, "--manifest", manifest, "--work-artifact-root", f.artifacts.root, "--work-recovery-inventory", config, "--destination", snapshot]);
  expect(copied.code, copied.error).toBe(0); expect(JSON.parse(copied.output).workRecovery.components).toHaveLength(3);
  await f.owner.drain(); f.owner.close(); f.journal.close(); f.broker.close();
  const args = ["restore", "--owner", "owner", "--snapshot", snapshot, "--destination", target, "--old-owner-fenced"];
  const rejected = await call(args); expect(rejected.code).not.toBe(0); expect(existsSync(target)).toBe(false);
  const restored = await call([...args, "--old-executors-fenced"]); expect(restored.code, restored.error).toBe(0); expect(JSON.parse(restored.output).recoveryNotice).toContain("not permission to signal stored PIDs");
});

async function restoredAdmission(legacyIssued = false) {
  const f = await executingWork(), receipt = await f.receipt(); f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump();
  f.owner.start({ id: "prepoint-wait", type: "echo", version: "1", input: "retained legacy wait" });
  if (legacyIssued) { await f.owner.pump(); f.owner.advertise("legacy", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 }); expect(f.owner.claim("legacy", "legacy-before-restore")).not.toBeNull(); }
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js"), root = dirname(f.path), snapshot = join(root, "admission-snapshot"), destination = join(root, "admission-restored");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root, { version: 1, components: [
    { id: "executor", role: "executor", identity: "owner", path: join(root, "executor.db"), artifact_root: f.artifacts.root, workers: ["owner"] },
    { id: "broker", role: "broker", identity: "local-host", path: join(root, "resource.db") },
  ] });
  const later = await executingWork(f, "accepted-after-snapshot"), laterReceipt = await later.receipt(); later.owner.completeWorkReceipt("owner", later.task.token, laterReceipt); await later.owner.pump();
  expect(later.owner.get(later.accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" });
  await f.owner.drain(); f.owner.close(); f.journal.close(); later.journal.close(); f.broker.close();
  await restoreWorkflows(snapshot, destination, "owner", true, true);
  const artifacts = new WorkArtifactStore(join(destination, "work-artifacts")), broker = new WorkResourceBroker({ path: join(destination, "work-recovery", "broker.db"), broker: "local-host", limits: { local: { kind: "host" } } }); cleanup.push(() => broker.close());
  const workflow = { ...f.workflow, path: join(destination, `${f.workflow.digest}.mjs`) }, owner = new WorkflowOwner({ id: "owner", path: join(destination, "workflows.db"), artifacts: [workflow], activityArtifacts: { echo: workflow.digest }, executor: new ProcessExecutor(), workArtifacts: artifacts,
    workResources: { host: () => ({ broker: "local-host", resource: "local" }), brokers: new Map([["local-host", broker]]) }, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const resolve = vi.fn(async (request: WorkSubmission) => { const result = f.resolution(request); result.plan.validation = { mode: "none" }; return result; });
  const service = new WorkAdmissionService({ owner, authenticate: async () => f.authority, resolve });
  const epoch = owner.recoveryAdmission!.epoch, decision = { request_id: "c7e6eb20-d9cf-4d76-8b5c-6b54a88931c0", expected_epoch: epoch,
    reason: "Reviewed surviving post-snapshot receipts and destinations.", residual_risk: "Unknown historical work stays unresolved; only explicit new invocations are enabled.", effect_paths_fenced: true as const, post_snapshot_work_reviewed: true as const };
  return { ...f, owner, broker, artifacts, workflow, destination, later, service, resolve, epoch, decision };
}
it("restore activation: gates missing post-snapshot keys, preserves existing lookup and enables only a fresh generation", async () => {
  const f = await restoredAdmission(); expect(f.owner.recoveryAdmission).toMatchObject({ active: false, epoch: f.epoch });
  expect((await f.service.submit(f.request, "alice")).work_id).toBe(f.accepted.work_id);
  expect(f.owner.start({ id: "prepoint-wait", type: "echo", version: "1", input: "retained legacy wait" }).status).toBe("blocked");
  const old = { ...f.request, idempotency_key: "accepted-after-snapshot" };
  expect(f.owner.workByKey(f.authority.namespace, old.idempotency_key)).toBeNull();
  await expect(f.service.submit(old, "alice")).rejects.toMatchObject({ code: "RecoveryAdmissionPaused" }); expect(f.resolve).not.toHaveBeenCalled();
  expect(() => f.owner.start({ id: "unconfirmed-legacy", type: "echo", version: "1", input: "unknown" })).toThrow(/paused after restore/);
  const pausedFeatures = f.features(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 }, { ...pausedFeatures, executors: [...pausedFeatures.executors], features: [...pausedFeatures.features] });
  expect(f.owner.claimWork("owner", "paused-claim")).toBeNull();
  const ack = f.owner.activateAdmission(f.decision, "operator"); expect(f.owner.activateAdmission(f.decision, "operator")).toEqual(ack);
  expect(f.owner.get("prepoint-wait").status).toBe("blocked");
  await expect(f.service.submit(old, "alice")).rejects.toMatchObject({ code: "RecoveryEpochRequired" });
  await expect(f.service.submit({ ...old, recovery_epoch: f.epoch }, "alice")).rejects.toMatchObject({ code: "RecoveryEpochRequired" });
  const fresh = { ...f.request, recovery_epoch: f.epoch, idempotency_key: `${f.epoch}:fresh` };
  const accepted = await f.service.submit(fresh, "alice"); expect(accepted.workflow_id.startsWith(`${f.epoch}:`)).toBe(true);
  await f.owner.pump(); const features = f.features(); f.owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 }, { ...features, executors: [...features.executors], features: [...features.features, "declared-validation"] });
  expect(f.owner.claimWork("owner", "paused-claim")).toBeNull();
  let task = f.owner.claimWork("owner", "after-activation"); for (let turn = 0; !task && turn < 4; turn++) task = f.owner.claimWork("owner", `after-activation-${turn}`); expect(task).not.toBeNull();
  expect(task!.runId).toBe(accepted.workflow_id); task!.work = f.owner.beginWork("owner", task!.token); task!.deadline = task!.work.deadline;
  const journal = new ExecutorJournal({ path: join(f.destination, "fresh-executor.db"), installation: "owner", artifacts: f.artifacts }); cleanup.push(() => journal.close());
  const { WorkProcessSupervisor } = await import("./work-process-supervisor.js"); const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts: f.artifacts, executor: new ProcessExecutor(), authorize: async start => f.owner.assertWorkEffect("owner", start.attempt_id) ? f.owner.beginWork("owner", start.attempt_id) : null, outputIdentity: () => f.authority.namespace.identity_id }); cleanup.push(() => supervisor.close());
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, task!.work![key as keyof typeof task.work]])));
  await supervisor.start(task!); const receipt = (await supervisor.wait(binding))!; f.owner.completeWorkReceipt("owner", task!.token, receipt); await f.owner.pump();
  expect(f.owner.get(accepted.workflow_id).outcome).toEqual({ ok: true, value: "hello" }); expect(f.owner.get("prepoint-wait").status).toBe("blocked");
});
it("restore activation: requires exact epoch, explicit attestations and an immutable actor-bound audit", async () => {
  const f = await restoredAdmission();
  expect(() => f.owner.activateAdmission({ ...f.decision, expected_epoch: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439" }, "operator")).toThrow(/current recovery generation/);
  expect(() => f.owner.activateAdmission({ ...f.decision, effect_paths_fenced: false } as never, "operator")).toThrow();
  expect(() => f.owner.activateAdmission({ ...f.decision, actor: "forged" } as never, "operator")).toThrow();
  f.owner.activateAdmission(f.decision, "operator");
  expect(() => f.owner.activateAdmission(f.decision, "another-operator")).toThrow(/another immutable/);
  expect(() => f.owner.activateAdmission({ ...f.decision, reason: "Changed decision" }, "operator")).toThrow(/another immutable/);
  const db = new SqliteDatabase(join(f.destination, "workflows.db"));
  try { expect(db.prepare("SELECT count(*) n FROM workflow_recovery_activations").get()?.n).toBe(1); expect(() => db.prepare("UPDATE workflow_recovery_activations SET request='{}'").run()).toThrow(/immutable/); } finally { db.close(); }
});
it.each([true, false])("restore activation: replay resolves lost COMMIT acknowledgement without another decision (%s)", async applied => {
  const f = await restoredAdmission(), store = Reflect.get(f.owner, "store") as WorkflowStore, db = Reflect.get(store, "db") as SqliteDatabase, exec = db.exec.bind(db); let lost = false;
  vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT" && !lost) { lost = true; if (applied) exec(sql); throw new Error("activation acknowledgement lost"); } return exec(sql); });
  expect(() => f.owner.activateAdmission(f.decision, "operator")).toThrow(/acknowledgement lost/);
  const ack = f.owner.activateAdmission(f.decision, "operator"); expect(ack.epoch).toBe(f.epoch); expect(f.owner.recoveryAdmission?.active).toBe(true);
});
it("restore activation: a second restore rotates the barrier and keeps earlier activation evidence historical", async () => {
  const f = await restoredAdmission(); f.owner.activateAdmission(f.decision, "operator");
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js"), snapshot = join(f.destination, "second-snapshot"), destination = join(f.destination, "second-restore");
  await snapshotWorkflows(join(f.destination, "workflows.db"), snapshot, "owner", [f.workflow], f.artifacts.root);
  await f.owner.drain(); f.owner.close(); await restoreWorkflows(snapshot, destination, "owner", true);
  const artifacts = new WorkArtifactStore(join(destination, "work-artifacts")), owner = new WorkflowOwner({ id: "owner", path: join(destination, "workflows.db"), artifacts: [{ ...f.workflow, path: join(destination, `${f.workflow.digest}.mjs`) }], executor: new ProcessExecutor(), workArtifacts: artifacts }); cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.recoveryAdmission?.active).toBe(false); expect(owner.recoveryAdmission?.epoch).not.toBe(f.epoch);
  expect(() => owner.activateAdmission(f.decision, "operator")).toThrow(/current recovery generation/);
  expect(() => owner.activateAdmission({ ...f.decision, expected_epoch: owner.recoveryAdmission!.epoch }, "operator")).toThrow(/another recovery generation/);
  expect(() => owner.start({ id: `${f.epoch}:old-new-invocation`, recoveryEpoch: f.epoch, type: "echo", version: "1", input: null })).toThrow(/paused after restore/);
});
it("restore activation: offline maintenance administration refuses a running owner and audits explicit activation", async () => {
  const f = await restoredAdmission(), database = join(f.destination, "workflows.db");
  const call = (args: string[]) => new Promise<{ code: number | null; output: string; error: string }>(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./maintenance-cli.ts", import.meta.url)), ...args, "--owner", "owner", "--database", database], { stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = "";
    child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { error += String(data); }); child.once("close", code => resolve({ code, output, error }));
  });
  expect((await call(["recovery-status"])).code).not.toBe(0);
  await f.owner.drain(); f.owner.close();
  const status = await call(["recovery-status"]); expect(status.code, status.error).toBe(0); expect(JSON.parse(status.output)).toMatchObject({ recovery: { epoch: f.epoch, active: false }, activation: null });
  const args = ["activate-admission", "--epoch", f.epoch, "--request-id", f.decision.request_id, "--reason", f.decision.reason, "--residual-risk", f.decision.residual_risk];
  expect((await call(args)).code).not.toBe(0);
  const first = await call([...args, "--effect-paths-fenced", "--post-snapshot-work-reviewed"]), replay = await call([...args, "--effect-paths-fenced", "--post-snapshot-work-reviewed"]);
  expect(first.code, first.error).toBe(0); expect(replay.code, replay.error).toBe(0); expect(JSON.parse(replay.output)).toEqual(JSON.parse(first.output));
  const after = await call(["recovery-status"]); expect(JSON.parse(after.output)).toMatchObject({ recovery: { active: true }, activation: { decision: { actor: "local-operator", reason: f.decision.reason }, acknowledgement: { request_id: f.decision.request_id } } });
});

it("restore activation: pause during async resolution is rechecked in the acceptance transaction", async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority, resolve: async request => { entered(); await gate; return f.resolution(request); } });
  const pending = service.submit(f.request, "alice"); await ready;
  const { pauseRestoredRuns } = await import("./recovery-fence.js"), db = f.inspect(); try { pauseRestoredRuns(db); } finally { db.close(); }
  release(); await expect(pending).rejects.toMatchObject({ code: "RecoveryAdmissionPaused" }); expect(f.counts().workflow_work_admissions).toBe(0);
});

it("restore activation: global approval cannot resume a legacy run with unsettled effect evidence", async () => {
  const f = await restoredAdmission(true); f.owner.activateAdmission(f.decision, "operator");
  expect(() => f.owner.resume("prepoint-wait")).toThrow(/execution\/effects remain unproven/);
  const db = new SqliteDatabase(join(f.destination, "workflows.db"));
  try { expect(db.prepare("SELECT count(*) n FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='prepoint-wait'").get()?.n).toBe(1); } finally { db.close(); }
});

it.each([false, true])("restored views: an accepted unstarted task immediately reports the blocked coordinator (older checkpoint=%s)", async olderCheckpoint => {
  const f = await fixture(), accepted = await f.service().submit(f.request, "alice");
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(dirname(f.path), "unstarted-view-snapshot"), destination = join(dirname(f.path), "unstarted-view-restore");
  await snapshotWorkflows(f.path, snapshot, "owner", [f.workflow], f.artifacts.root); await f.owner.drain(); f.owner.close();
  await restoreWorkflows(snapshot, destination, "owner", true);
  if (olderCheckpoint) {
    const db = new SqliteDatabase(join(destination, "workflows.db"));
    try { db.exec("DELETE FROM workflow_meta WHERE key='recovery-work-views'"); } finally { db.close(); }
  }
  const artifacts = new WorkArtifactStore(join(destination, "work-artifacts")), owner = new WorkflowOwner({ id: "owner", path: join(destination, "workflows.db"), artifacts: [{ ...f.workflow, path: join(destination, `${f.workflow.digest}.mjs`) }], executor: new ProcessExecutor(), workArtifacts: artifacts });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.get(accepted.workflow_id).status).toBe("blocked");
  const work = owner.workById(f.authority.namespace, accepted.work_id)!;
  expect(work.facts.coordinator).toBe("blocked"); expect(projectWorkState(work.facts).state).toBe("needs-attention");
  expect(owner.listWork({ kind: "installation", installation: "owner" }, { states: ["needs-attention"] }).total).toBe(1);
});

it("restored views: bounded publication checkpoints survive a failed later batch without exposing stale counts", async () => {
  const f = await fixture(), accepted = [];
  for (let i = 0; i < 70; i++) accepted.push(await f.service().submit({ ...f.request, idempotency_key: `restore-view-${i}` }, "alice"));
  await f.owner.drain(); f.owner.close();
  const { pauseRestoredRuns } = await import("./recovery-fence.js");
  const db = f.inspect(); let epoch: string;
  try {
    epoch = pauseRestoredRuns(db);
    const rows = db.prepare("SELECT run_id FROM workflow_work_admissions ORDER BY run_id").all();
    db.exec(`CREATE TRIGGER fail_restore_view BEFORE UPDATE OF record ON workflow_work_admissions WHEN NEW.run_id='${rows[64]!.run_id}' BEGIN SELECT RAISE(ABORT,'restore view unavailable'); END`);
  } finally { db.close(); }
  const options = { id: "owner", path: f.path, artifacts: [f.workflow], executor: new ProcessExecutor(), workArtifacts: f.artifacts };
  expect(() => new WorkflowOwner(options)).toThrow("restore view unavailable");
  const inspect = f.inspect();
  try {
    expect(JSON.parse(String(inspect.prepare("SELECT value FROM workflow_meta WHERE key='recovery-work-views'").get()!.value))).toMatchObject({ epoch, complete: false });
    expect(inspect.prepare("SELECT count(*) n FROM workflow_work_index WHERE state='needs-attention'").get()!.n).toBe(64);
    inspect.exec("DROP TRIGGER fail_restore_view");
  } finally { inspect.close(); }
  const owner = new WorkflowOwner(options); cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.listWork({ kind: "installation", installation: "owner" }, { states: ["needs-attention"] }).total).toBe(70);
  expect(owner.listWork({ kind: "installation", installation: "owner" }, { states: ["running", "queued"] }).total).toBe(0);
  for (const work of accepted) expect(owner.workById(f.authority.namespace, work.work_id)).toMatchObject({ revision: 2, facts: { coordinator: "blocked", physical: "not-started" } });
  const replica = new WorkProjectionReplica({ path: join(dirname(f.path), "restored-views.db"), owner: "owner" }); cleanup.push(() => replica.close());
  await expect(owner.publishWorkProjections({ apply: work => { replica.apply(work); throw new Error("lost restored view acknowledgement"); } })).rejects.toThrow("lost restored view acknowledgement");
  while (await owner.publishWorkProjections(replica)) { /* bounded delivery batches */ }
  for (const work of accepted) expect(replica.get(f.authority.namespace, work.work_id)).toMatchObject({ revision: 2, facts: { coordinator: "blocked" } });
  await owner.drain(); owner.close();
  const reopened = new WorkflowOwner(options); cleanup.push(async () => { await reopened.drain(); reopened.close(); });
  for (const work of accepted) expect(reopened.workById(f.authority.namespace, work.work_id)?.revision).toBe(2);
});

it.each([false, true])("restored views: preserves physical uncertainty or an accepted terminal result (settled=%s)", async settled => {
  const f = await executingWork(), receipt = await f.receipt();
  if (settled) { f.owner.completeWorkReceipt("owner", f.task.token, receipt); await f.owner.pump(); }
  const before = f.owner.workById(f.authority.namespace, f.accepted.work_id)!;
  await f.owner.drain(); f.owner.close();
  const { pauseRestoredRuns } = await import("./recovery-fence.js"), db = f.inspect();
  try { pauseRestoredRuns(db); } finally { db.close(); }
  const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], executor: new ProcessExecutor(), workArtifacts: f.artifacts, workResources: f.workResources });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const after = owner.workById(f.authority.namespace, f.accepted.work_id)!;
  expect(after.facts).toMatchObject(settled ? { coordinator: "completed", physical: "ceased", effect: "known" } : { coordinator: "blocked", physical: "unknown", effect: "uncertain" });
  if (settled) expect(after).toEqual(before);
  else {
    expect(after.revision).toBe(before.revision + 1);
    expect(owner.completeWorkReceipt("owner", f.task.token, receipt)).toBe("stale");
    expect(owner.workById(f.authority.namespace, f.accepted.work_id)).toMatchObject({ facts: { coordinator: "blocked", physical: "ceased" }, reason: { code: "LateExecutionEvidence" } });
  }
});

it.each([
  { effectClass: "pure" as const, stopHost: false, crashAfterReceipt: false },
  { effectClass: "pure" as const, stopHost: false, crashAfterReceipt: true },
  { effectClass: "non-repeatable" as const, stopHost: false, crashAfterReceipt: false },
  { effectClass: "non-repeatable" as const, stopHost: true, crashAfterReceipt: false },
])("process host: independent $effectClass execution recovers after shutdown (host=$stopHost, receipt crash=$crashAfterReceipt)", async ({ effectClass, stopHost, crashAfterReceipt }) => {
  const root = mkdtempSync(join(tmpdir(), "independent-work-host-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "task.mjs"); writeFileSync(source, `export const definitions=[{type:'echo',version:'1',*run(input){return yield {kind:'activity',type:'echo',input};}}]; export const activities={echo:async input=>{if(input.neverEnd){while(true){}}let checksum=0;for(let i=0;i<input.iterations;i++)checksum=(checksum*1664525+1013904223)>>>0;return {value:input.value,checksum};}};`);
  const f = await fixture(undefined, source), service = new WorkAdmissionService({ owner: f.owner, authenticate: async () => f.authority,
    resolve: async request => { const resolved = f.resolution(request); return { ...resolved, plan: { ...resolved.plan, validation: { mode: "none" as const }, effect_policy: effectClass === "pure" ? resolved.plan.effect_policy : { class: effectClass, max_attempts: 1 as const } } }; } });
  const accepted = await service.submit({ ...f.request, inputs: { iterations: 800000000, neverEnd: effectClass !== "pure", value: "independent-result" } }, "alice");
  await f.owner.pump(); await f.owner.drain(); f.owner.close();
  const credential = join(root, "worker-credential"); writeFileSync(credential, "barry_wk_independent-host-fixture", { mode: 0o600 });
  const ownerConfig = join(root, "owner.json"), configuration = { database: f.path, artifacts: f.artifacts.root, workflow: f.workflow,
    broker: join(dirname(f.path), "resource.db"), scope: f.authority.caller_ceiling, credential_file: credential, port: 0 };
  const launch = (entry: string, args: string[]) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", diagnostic = ""; child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-4000); });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; });
    return { child, closed, output: () => output, diagnostic: () => diagnostic };
  };
  const ownerEntry = fileURLToPath(new URL("./work-owner-host-fixture.mjs", import.meta.url));
  writeFileSync(ownerConfig, JSON.stringify(configuration)); const firstOwner = launch(ownerEntry, [ownerConfig]);
  await expect.poll(firstOwner.output, { timeout: 10000 }).toContain("port");
  configuration.port = (JSON.parse(firstOwner.output().trim()) as { port: number }).port;
  const hostConfig = join(root, "host.json"), hostDirectory = join(root, "host");
  writeFileSync(hostConfig, JSON.stringify({ version: 1, installation: "owner", directory: hostDirectory, artifact_root: f.artifacts.root,
    owners: [{ id: "owner", url: `http://127.0.0.1:${configuration.port}`, credential_file: credential }], activities: [{ type: "echo", source, digest: f.workflow.digest }], capacity: 1 }));
  const hostEntry = fileURLToPath(new URL("../../dist/workflows/work-process-host-cli.js", import.meta.url));
  let host = launch(hostEntry, ["--config", hostConfig]);
  await expect.poll(host.output, { timeout: 10000 }).toContain("process-work-host-ready");
  const journalPath = join(hostDirectory, "work-executor.db");
  const inspectJournal = () => {
    const db = new SqliteDatabase(journalPath);
    try { const row = db.prepare("SELECT binding,observation FROM executions LIMIT 1").get(); return row ? { binding: executionBindingSchema.parse(JSON.parse(String(row.binding))), observation: JSON.parse(String(row.observation)) as { physical_state: string } } : null; }
    finally { db.close(); }
  };
  await expect.poll(() => inspectJournal()?.observation.physical_state, { timeout: 10000, message: `${host.diagnostic()} ${firstOwner.diagnostic()}` }).toBe("running");
  await expect.poll(() => {
    const db = f.inspect();
    try { return JSON.parse(String(db.prepare("SELECT record FROM workflow_work_admissions WHERE run_id=?").get(accepted.workflow_id)!.record)).facts.physical; }
    finally { db.close(); }
  }, { timeout: 10000 }).toBe("running");
  const binding = inspectJournal()!.binding;
  if (effectClass === "pure") {
    const duplicate = launch(hostEntry, ["--config", hostConfig]); await duplicate.closed;
    expect(duplicate.child.exitCode).toBe(1); expect(duplicate.output()).not.toContain("process-work-host-ready");
    expect(duplicate.diagnostic()).not.toContain("barry_wk_independent-host-fixture");
  }
  if (stopHost) { host.child.kill("SIGTERM"); await host.closed; expect(host.child.exitCode, host.diagnostic()).toBe(0); }
  else { firstOwner.child.kill("SIGKILL"); await firstOwner.closed; }
  const journal = new ExecutorJournal({ path: journalPath, installation: "owner", artifacts: f.artifacts }); cleanup.push(() => journal.close());
  await expect.poll(() => journal.receipt(binding)?.physical_state, { timeout: 15000 }).toBe("ceased");
  if (!stopHost) expect(host.child.exitCode, host.diagnostic()).toBeNull();
  const receipt = journal.receipt(binding)!;
  expect(receipt.outcome).toBe(effectClass === "pure" ? "complete" : "uncertain");
  if (effectClass === "pure") expect(JSON.parse(f.artifacts.verify(receipt.output!).toString())).toMatchObject({ value: "independent-result" });
  const hostReservation = journal.retainedStart(binding)!.resources.host_reservation!;
  expect(f.broker.inspect(hostReservation)?.state).toBe("held");
  if (crashAfterReceipt) {
    // Lose the guardian after the durable receipt, while its owner is still down.
    // OS lock release and retained delivery must survive both process deaths.
    host.child.kill("SIGKILL"); await host.closed;
    host = launch(hostEntry, ["--config", hostConfig]);
    await expect.poll(host.output, { timeout: 10000 }).toContain("process-work-host-ready");
    expect(journal.receipt(binding)?.receipt_digest).toBe(receipt.receipt_digest);
  }
  writeFileSync(ownerConfig, JSON.stringify(configuration)); const replacement = stopHost ? firstOwner : launch(ownerEntry, [ownerConfig]);
  await expect.poll(replacement.output, { timeout: 10000 }).toContain("port");
  if (stopHost) { host = launch(hostEntry, ["--config", hostConfig]); await expect.poll(host.output, { timeout: 10000 }).toContain("process-work-host-ready"); }
  await expect.poll(() => journal.pendingDeliveryCount(), { timeout: 10000 }).toBe(0);
  await expect.poll(() => f.broker.inspect(hostReservation)?.state, { timeout: 10000 }).toBe("released");
  if (effectClass === "pure" && !crashAfterReceipt) await expect.poll(() => {
    const db = f.inspect();
    try { return db.prepare("SELECT status FROM workflow_runs WHERE id=?").get(accepted.workflow_id)?.status; }
    finally { db.close(); }
  }, { timeout: 10000 }).toBe("completed");
  const db = f.inspect();
  try {
    expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(1);
    const work = JSON.parse(String(db.prepare("SELECT record FROM workflow_work_admissions WHERE run_id=?").get(accepted.workflow_id)!.record));
    expect(work).toMatchObject({ receipt_ref: receipt.receipt_ref, facts: { physical: "ceased" } });
    if (crashAfterReceipt) expect(work).toMatchObject({ facts: { coordinator: "blocked" }, reason: { code: "LateExecutionEvidence" } });
    else if (effectClass === "pure") expect(work.facts.coordinator).toBe("completed");
    else expect(work.facts.effect).toBe("uncertain");
  } finally { db.close(); }
  host.child.kill("SIGTERM"); await host.closed; expect(host.child.exitCode, host.diagnostic()).toBe(0);
  replacement.child.kill("SIGTERM"); await replacement.closed; expect(replacement.child.exitCode, replacement.diagnostic()).toBe(0);
  if (crashAfterReceipt) {
    const owner = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], executor: new ProcessExecutor(), workArtifacts: f.artifacts, workResources: f.workResources });
    cleanup.push(async () => { await owner.drain(); owner.close(); });
    const control = new WorkControlService({ owner, authorize: async () => ({ actor: "fixture-operator", scope: { kind: "installation" as const, installation: "owner" }, controls: ["reconcile" as const] }) });
    const request = { request_id: "0176c5d5-3f8c-4d35-ae5e-0a42c0052757", expected_revision: owner.workById(f.authority.namespace, accepted.work_id)!.revision,
      attempt_id: binding.attempt_id, receipt_digest: receipt.receipt_digest, reason: "Inspected original retained output and native cessation after both process deaths.", residual_risk: "Pure computation completed before guardian loss; no replacement application launch." };
    const ack = await control.reconcile(accepted.work_id, request, "operator");
    expect(await control.reconcile(accepted.work_id, request, "operator")).toEqual(ack);
    await owner.pump(); expect(owner.get(accepted.workflow_id).outcome).toMatchObject({ ok: true, value: { value: "independent-result" } });
    const db = f.inspect();
    try {
      expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(1);
      expect(db.prepare("SELECT count(*) n FROM workflow_work_reconciliations").get()?.n).toBe(1);
    } finally { db.close(); }
  }
}, 40000);

it("fair projection traversal survives 64 failing rows and owner restart before a later healthy row", async () => {
  const f = await fixture();
  const admitted = [];
  for (let index = 0; index < 65; index++) admitted.push(await f.service().submit({ ...f.request, request_id: crypto.randomUUID(), idempotency_key: `projection-fair-${index}` }, "alice"));
  admitted.sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
  const healthy = admitted.at(-1)!;
  const target = { apply: (work: typeof healthy) => { if (work.work_id !== healthy.work_id) throw new Error("persistently unavailable target"); return { work_id: work.work_id, revision: work.revision, digest: workProjectionDigest(work) }; } };
  await expect(f.owner.publishWorkProjections(target, 64)).rejects.toThrow("persistently unavailable");
  await f.owner.drain(); f.owner.close();
  const restored = new WorkflowOwner({ id: "owner", path: f.path, artifacts: [f.workflow], executor: new ProcessExecutor(), workArtifacts: f.artifacts, authorizeWork: () => f.authority.caller_ceiling });
  cleanup.push(async () => { await restored.drain(); restored.close(); });
  // Any error remains visible, but healthy publication beyond the failed page must progress.
  await restored.publishWorkProjections(target, 64).catch(() => {});
  const current = restored.workById(f.authority.namespace, healthy.work_id)!;
  expect(current.projection.applied_revision).toBe(current.revision);
});
