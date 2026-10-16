/** Reference-aware 30/90-day Work retention (P7.3a, G6, RT1-RT4). */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkflowOwner } from "./workflow-owner.js";
import { ProcessExecutor } from "./executor.js";
import { inspectArtifact, artifactAbi } from "./artifacts.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkflowError } from "./errors.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import type { WorkAuthority } from "./work-authority.js";
import type { WorkSubmission } from "./work-contracts.js";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import { executionBindingSchema, logicalStageEffectKey } from "./work-contracts.js";
import { WorkResourceBroker } from "./work-resource-broker.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sourcePath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
/** Trimmed copy of the work-admission.test.ts fixture/executingWork pair (not exported there). */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "work-retention-gaps-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const mutableSource = join(root, "mutable-workflow.mjs");
  writeFileSync(mutableSource, readFileSync(sourcePath));
  const workflow = inspectArtifact(mutableSource, "echo", "1"),
    finish = inspectArtifact(mutableSource, "finish", "1");
  const source = artifacts.stage(readFileSync(sourcePath), {
    owner_identity: null,
    purpose: "source",
    media_type: "text/javascript",
  });
  const path = join(root, "owner.db");
  const executor = new ProcessExecutor();
  const broker = new WorkResourceBroker({
    path: join(root, "resource.db"),
    broker: "local-host",
    limits: { local: { kind: "host" } },
  });
  cleanup.push(() => broker.close());
  const workResources = {
    host: () => ({ broker: "local-host", resource: "local" }),
    brokers: new Map([["local-host", broker]]),
  };
  const owner = new WorkflowOwner({
    id: "owner",
    path,
    artifacts: [workflow, finish],
    activityArtifacts: { echo: workflow.digest },
    executor,
    workArtifacts: artifacts,
    workResources,
    authorizeWork: () => scope,
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
  const resolution = (input: WorkSubmission): WorkResolution => {
    const grant = {
      version: 2 as const,
      grant_ref: "work-grant",
      revision: 1,
      namespace: authority.namespace,
      authorizer: authority.namespace.principal_id,
      created_by: authority.namespace.principal_id,
      approved_at: 100,
      original_caller_ceiling: authority.caller_ceiling,
      effective_scope: authority.caller_ceiling,
      definition_bounds_digest: boundFingerprint(authority.caller_ceiling.bound),
      policy_revision: "policy-1",
    };
    return {
      title: "First definition",
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
          lane: "unscheduled",
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
  const service = new WorkAdmissionService({
    owner,
    authenticate: async (_input: WorkSubmission, credentials: string) => {
      if (credentials !== "alice") throw new WorkflowError("Forbidden", "Not authorized.", 403);
      return authority;
    },
    resolve: async (input: WorkSubmission) => resolution(input),
  });
  const features = {
    version: 2 as const,
    installation: "owner",
    boot_identity: "boot",
    observed_at: Date.now() - 1,
    expires_at: Date.now() + 15000,
    executors: ["process", "structured-agent", "model", "scoped-tool"],
    features: [
      "journal-inspect",
      "cancel-tombstone",
      "stop-ack",
      "immutable-source",
      "scoped-effects",
    ],
    runtimes: {},
    workspaces: [],
    containment: "portable" as const,
  };
  const inspect = () => new SqliteDatabase(path);
  return {
    owner,
    executor,
    artifacts,
    path,
    workflow,
    request,
    authority,
    service,
    features,
    inspect,
  };
}
/** Drive one Work run through the real journal and receipt path to `completed`. */
async function completedWork() {
  const f = await fixture(),
    accepted = await f.service.submit(f.request, "alice");
  await f.owner.pump();
  f.owner.advertiseWork(
    "owner",
    { types: ["echo"], artifacts: { echo: f.workflow.digest }, capacity: 1 },
    f.features as Parameters<WorkflowOwner["advertiseWork"]>[2],
  );
  const task = f.owner.claimWork("owner", "work-claim")!;
  expect(task).not.toBeNull();
  const request = f.owner.beginWork("owner", task.token);
  task.work = request;
  task.deadline = request.deadline;
  task.timeoutMs = Math.max(1, request.deadline - Date.now());
  const binding = executionBindingSchema.parse(
    Object.fromEntries(
      Object.keys(executionBindingSchema.shape).map((key) => [
        key,
        request[key as keyof typeof request],
      ]),
    ),
  );
  const journal = new ExecutorJournal({
    path: join(dirname(f.path), "executor.db"),
    installation: "owner",
    artifacts: f.artifacts,
  });
  cleanup.push(() => journal.close());
  journal.start(request);
  expect(f.owner.assertWorkEffect("owner", task.token)).toBe(true);
  const claim = journal.claimStage(binding, "execution");
  f.owner.observeWork("owner", task.token, claim.observation);
  const value = await f.executor.activity(f.workflow)(task.input, {
    ...task,
    signal: new AbortController().signal,
  });
  const output = f.artifacts.stage(Buffer.from(JSON.stringify(value)), {
    owner_identity: f.authority.namespace.identity_id,
    purpose: "output",
    media_type: "application/json",
  });
  journal.completeStage(
    binding,
    {
      stage: "execution",
      effect_key: logicalStageEffectKey(
        binding.owner,
        binding.workflow_id,
        binding.activity_id,
        "execution",
      ),
      attempt_id: task.token,
      state: "passed",
      started_at: claim.observation.observed_at,
      completed_at: Date.now(),
      result: output,
    },
    "ceased",
  );
  const unsigned = {
    ...binding,
    receipt_ref: journal.newReceiptRef(),
    revision: journal.inspect(binding)!.revision + 1,
    committed_at: Date.now(),
    physical_state: "ceased" as const,
    effect_certainty: "known" as const,
    outcome: "complete" as const,
    stages: journal.stageReceipts(binding),
    output,
    summary: "isolated echo result",
    validation: "skipped" as const,
    validation_failures: null,
  };
  const receipt = journal.commitReceipt(binding, {
    ...unsigned,
    receipt_digest: workReceiptDigest(unsigned),
  });
  expect(f.owner.completeWorkReceipt("owner", task.token, receipt)).toBe("accepted");
  await f.owner.pump();
  return { ...f, accepted, runId: task.runId };
}
const pruneAll = (owner: WorkflowOwner, before: number) => {
  let batches = 0;
  while (batches < 50 && owner.prune(before)) batches++;
  return batches;
};

it("P7.3a / G6: prune enforces 30-day completed and 90-day non-completed Work retention, refuses pending projections/unsettled receipts, and archives settled Work runs while preserving idempotency tombstones", async () => {
  const f = await completedWork();
  expect(f.owner.get(f.runId)).toMatchObject({
    status: "completed",
    outcome: { ok: true, value: "hello" },
  });
  f.owner.start({ id: "plain", type: "finish", version: "1", input: "plain result" });
  await f.owner.pump();
  expect(f.owner.get("plain")).toMatchObject({
    status: "completed",
    outcome: { ok: true, value: "plain result" },
  });

  let workClosedAt = 0;
  const db = f.inspect();
  try {
    const row = db
      .prepare("SELECT closed_at, retention_hold FROM workflow_runs WHERE id=?")
      .get(f.runId) as { closed_at: number; retention_hold: number };
    expect(row.closed_at).toBeGreaterThan(0);
    expect(row.retention_hold).toBe(0);
    workClosedAt = row.closed_at;
    expect(
      db.prepare("SELECT count(*) AS n FROM workflow_work_admissions WHERE run_id=?").get(f.runId),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }

  // 1. Cutoff before 30 days collects plain run immediately, but keeps completed Work run.
  const before30Days = workClosedAt + 29 * 86_400_000;
  expect(pruneAll(f.owner, before30Days)).toBeGreaterThan(0);
  expect(f.owner.get("plain")).toMatchObject({ status: "completed", outcome: null });
  expect(f.owner.get("plain").error).toContain("RunArchived");
  expect(f.owner.get(f.runId)).toMatchObject({
    status: "completed",
    outcome: { ok: true, value: "hello" },
    error: null,
  });

  // 2. Pending outbox projection (applied_revision < desired_revision) blocks Work retention even past 30 days.
  const after30Days = workClosedAt + 31 * 86_400_000;
  const holdDb = f.inspect();
  try {
    holdDb
      .prepare(
        "UPDATE workflow_work_outbox SET applied_revision = desired_revision - 1 WHERE run_id=?",
      )
      .run(f.runId);
  } finally {
    holdDb.close();
  }
  expect(f.owner.prune(after30Days)).toBe(false);

  // 3. Failed/cancelled Work runs require 90 days before collection.
  const statusDb = f.inspect();
  try {
    statusDb
      .prepare("UPDATE workflow_work_outbox SET applied_revision = desired_revision WHERE run_id=?")
      .run(f.runId);
    statusDb.prepare("UPDATE workflow_runs SET status='failed' WHERE id=?").run(f.runId);
  } finally {
    statusDb.close();
  }
  expect(f.owner.prune(workClosedAt + 89 * 86_400_000)).toBe(false);

  // 4. Restore status='completed' and prune past 30 days: writes tombstone, deletes bulk history, preserves Work admission idempotency record.
  const restoreDb = f.inspect();
  try {
    restoreDb.prepare("UPDATE workflow_runs SET status='completed' WHERE id=?").run(f.runId);
  } finally {
    restoreDb.close();
  }
  expect(pruneAll(f.owner, after30Days)).toBeGreaterThan(0);
  expect(f.owner.prune(after30Days)).toBe(false);
  expect(f.owner.get(f.runId)).toMatchObject({ status: "completed", input: null, outcome: null });
  expect(f.owner.get(f.runId).error).toContain("RunArchived");

  const after = f.inspect();
  try {
    expect(after.prepare("SELECT id FROM workflow_tombstones ORDER BY id").all()).toEqual(
      [{ id: "plain" }, { id: f.runId }].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      after
        .prepare("SELECT count(*) AS n FROM workflow_work_admissions WHERE run_id=?")
        .get(f.runId),
    ).toEqual({ n: 1 });
    expect(
      after.prepare("SELECT count(*) AS n FROM workflow_events WHERE run_id=?").get(f.runId),
    ).toEqual({ n: 0 });
    expect(
      after.prepare("SELECT count(*) AS n FROM workflow_commands WHERE run_id=?").get(f.runId),
    ).toEqual({ n: 0 });
    expect(
      after
        .prepare("SELECT count(*) AS n FROM workflow_work_executions WHERE run_id=?")
        .get(f.runId),
    ).toEqual({ n: 0 });
    expect(
      after.prepare("SELECT count(*) AS n FROM workflow_work_outbox WHERE run_id=?").get(f.runId),
    ).toEqual({ n: 0 });
  } finally {
    after.close();
  }
});
