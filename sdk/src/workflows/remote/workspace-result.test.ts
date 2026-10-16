import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import type { WorkOwnerConnection } from "../work-activity-worker.js";
import { WorkArtifactStore, type WorkArtifactRef } from "../work-artifacts.js";
import { workGrantSchema, workPlanHash, workPlanSchema } from "../work-contracts.js";
import {
  workExecutionDelegationSchema,
  type WorkExecutionDelegation,
} from "../work-execution-delegation.js";
import type { ExecutionAccessV1 } from "./work-remote-transport.js";
import { scanWorkspaceTree } from "./workspace-input.js";
import { WorkspaceLockStore } from "./workspace-lock.js";
import {
  computeWorkspaceMappingDigest,
  prepareWorkspace,
  type WorkspaceMappingEntryV1,
} from "./workspace-mapping.js";
import {
  applyWorkspaceResultStaged,
  collectWorkspaceResult,
  verifyWorkspacePublicationConflicts,
} from "./workspace-result.js";

const roots: string[] = [];
const stores: { close(): void }[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-result-test-")));
  roots.push(dir);
  return dir;
}

function mockConnection(effectAllowed = true): WorkOwnerConnection {
  return {
    advertise: async () => {},
    claim: async () => null,
    heartbeat: async () => effectAllowed,
    effect: async () => effectAllowed,
    observe: async () => ({ status: "accepted" }),
    complete: async () => ({ status: "accepted" }),
  };
}

function buildDelegation(sourceRef: WorkArtifactRef, now = Date.now()): WorkExecutionDelegation {
  const rawScope = {
    identity: "id-1",
    traits: ["work-control"],
    bound: null,
    tools: { "bash:Bash": "write" as const },
    contracts: { "bash:Bash": "b".repeat(64) },
  };
  const scope = { ...rawScope, fingerprint: boundFingerprint(rawScope) };
  const namespace = {
    installation: "owner-1",
    principal_kind: "identity" as const,
    principal_id: "actor-1",
    identity_id: "id-1",
    caller_session_id: "sess-1",
  };
  const origin = {
    entry_point: "api",
    trigger: "invocation" as const,
    caller_session_id: "sess-1",
  };
  const grant = workGrantSchema.parse({
    version: 2,
    grant_ref: "grant-1",
    revision: 1,
    namespace,
    authorizer: "actor-1",
    created_by: "actor-1",
    approved_at: now,
    original_caller_ceiling: scope,
    effective_scope: scope,
    definition_bounds_digest: "2".repeat(64),
    policy_revision: "pol-1",
  });
  const nodeJob = {
    activity_type: "remote-job",
    source_digest: sourceRef.digest,
    scope,
    output: "json" as const,
  };
  const plan = workPlanSchema.parse({
    version: 2,
    definition: { kind: "job", reference: "remote-job" },
    workflow: {
      type: "remote-wf",
      version: "1",
      artifact_digest: sourceRef.digest,
      runtime_abi: "v1",
      input_digest: "3".repeat(64),
    },
    source_closure: [sourceRef],
    grant_ref: "grant-1",
    grant_revision: 1,
    executor_generation: "v2",
    grant_digest: boundFingerprint(grant),
    execution_profile: "portable",
    effect_policy: { class: "non-repeatable", max_attempts: 1 },
    validation: { mode: "none" },
    node_job: nodeJob,
    resources: {
      executor: "process",
      lane: "unscheduled",
      logical_reservation: "logical-1",
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
      provenance: "default",
    },
    execution_budget_ms: 60_000,
    dispatch_budget_ms: 60_000,
  });
  const planDigest = workPlanHash(plan);
  const admissionRequestHash = "1".repeat(64);
  const inputs = {};
  const requestHash = boundFingerprint({
    admission: admissionRequestHash,
    activity: "act-1",
    type: "remote-job",
    input: inputs,
  });

  return workExecutionDelegationSchema.parse({
    version: 1,
    admission_request_hash: admissionRequestHash,
    namespace,
    origin,
    grant,
    plan,
    start: {
      version: 2,
      owner: "owner-1",
      work_id: "work-1",
      workflow_id: "wf-1",
      activity_id: "act-1",
      attempt_id: "att-1",
      request_hash: requestHash,
      plan_digest: planDigest,
      grant_ref: "grant-1",
      grant_revision: 1,
      source: sourceRef,
      execution_fence: 1,
      deadline: now + 60_000,
      launch_authorized: true,
      inputs,
      effect_policy: plan.effect_policy,
      resources: { ...plan.resources, host_reservation: "host-1" },
      executor_generation: "v2",
      validation: { mode: "none" },
      node_job: nodeJob,
      activity_type: "remote-job",
      output_identity: "id-1",
    },
  });
}

describe("workspace-result", () => {
  it("collects added, modified, and deleted changes into an immutable WorkspaceResultManifestV1, detects conflicts, and applies atomically to a clean target", async () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(store, lockStore);

    const workerWs = join(root, "worker-ws");
    const targetRepo = join(root, "target-repo");
    mkdirSync(workerWs, { mode: 0o700 });
    mkdirSync(targetRepo, { mode: 0o700 });

    // Seed identical base tree in both workerWs and targetRepo
    for (const dir of [workerWs, targetRepo]) {
      mkdirSync(join(dir, "src"), { mode: 0o700 });
      writeFileSync(join(dir, "src/keep.ts"), "export const keep = true;\n", { mode: 0o600 });
      writeFileSync(join(dir, "src/modify.ts"), "export const v = 1;\n", { mode: 0o600 });
      writeFileSync(join(dir, "src/remove.ts"), "export const old = true;\n", { mode: 0o600 });
    }

    const wsStat = statSync(workerWs);
    const baseSnap = scanWorkspaceTree(workerWs);
    const entryBase = {
      version: 1 as const,
      resource_ref: "repo:app",
      mapping_version: 1,
      worker_installation: "worker-node-1",
      canonical_root: workerWs,
      dev: wsStat.dev,
      ino: wsStat.ino,
      writable_allowed: true,
      expected_base_digest: baseSnap.tree_digest,
    };
    const mappingDigest = computeWorkspaceMappingDigest(entryBase);
    const entry: WorkspaceMappingEntryV1 = { ...entryBase, mapping_digest: mappingDigest };

    const sourceRef = store.stage(Buffer.from("console.log('work');"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/javascript",
    });
    const delegation = buildDelegation(sourceRef);
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
      workerInstallation: "worker-node-1",
    };

    const prepared = await prepareWorkspace(
      access,
      {
        kind: "verified",
        resource_ref: "repo:app",
        mapping_version: 1,
        mapping_digest: mappingDigest,
        expected_base_digest: baseSnap.tree_digest,
        writable: true,
      },
      {
        workerInstallation: "worker-node-1",
        mappings: [entry],
        lockStore,
      },
    );

    // Mutate workerWs: modify modify.ts, delete remove.ts, add added.ts
    writeFileSync(join(workerWs, "src/modify.ts"), "export const v = 2;\n", { mode: 0o600 });
    unlinkSync(join(workerWs, "src/remove.ts"));
    writeFileSync(join(workerWs, "src/added.ts"), "export const added = 'new';\n", { mode: 0o600 });

    const collected = await collectWorkspaceResult(access, prepared.workspace, {
      baseSnapshot: prepared.baseSnapshot,
      localArtifacts: store,
      lockStore,
    });

    expect(collected.manifest.changes).toEqual([
      expect.objectContaining({ path: "src/added.ts", change_kind: "added" }),
      expect.objectContaining({ path: "src/modify.ts", change_kind: "modified" }),
      expect.objectContaining({ path: "src/remove.ts", change_kind: "deleted" }),
    ]);

    // 1. Conflict check against clean targetRepo succeeds
    const cleanCheck = verifyWorkspacePublicationConflicts(collected.manifest, targetRepo, {
      expectedResourceRef: "repo:app",
      expectedOwnerIdentity: "id-1",
    });
    expect(cleanCheck.ok).toBe(true);
    expect(cleanCheck.conflicts).toHaveLength(0);

    // 2. Inject conflicting edit in targetRepo -> conflict check reports drift and applyWorkspaceResultStaged refuses without mutating other files
    writeFileSync(join(targetRepo, "src/modify.ts"), "export const v = 999;\n", { mode: 0o600 });
    const driftedCheck = verifyWorkspacePublicationConflicts(collected.manifest, targetRepo, {
      expectedResourceRef: "repo:app",
    });
    expect(driftedCheck.ok).toBe(false);
    expect(driftedCheck.conflicts.map(c => c.reason)).toContain("modified_target_drifted");

    expect(() =>
      applyWorkspaceResultStaged(collected.manifest, {
        targetRoot: targetRepo,
        artifacts: store,
        authorizedBy: "actor-1",
        expectedResourceRef: "repo:app",
      }),
    ).toThrow(/WorkWorkspacePublicationConflict|publication conflict/);
    expect(readFileSync(join(targetRepo, "src/remove.ts"), "utf8")).toBe(
      "export const old = true;\n",
    );

    // 3. Restore targetRepo to expected base state and apply atomically
    writeFileSync(join(targetRepo, "src/modify.ts"), "export const v = 1;\n", { mode: 0o600 });
    const postApplySnap = applyWorkspaceResultStaged(collected.manifest, {
      targetRoot: targetRepo,
      artifacts: store,
      authorizedBy: "actor-1",
      expectedResourceRef: "repo:app",
      expectedOwnerIdentity: "id-1",
    });
    expect(postApplySnap.tree_digest).toBe(collected.manifest.result_tree_digest);
    expect(readFileSync(join(targetRepo, "src/modify.ts"), "utf8")).toBe("export const v = 2;\n");
    expect(readFileSync(join(targetRepo, "src/added.ts"), "utf8")).toBe(
      "export const added = 'new';\n",
    );
  });

  it("rejects unauthorized writes in a read-only workspace during collectWorkspaceResult", async () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(store, lockStore);

    const workerWs = join(root, "readonly-ws");
    mkdirSync(workerWs, { mode: 0o700 });
    writeFileSync(join(workerWs, "readme.txt"), "immutable\n", { mode: 0o600 });
    const wsStat = statSync(workerWs);
    const baseSnap = scanWorkspaceTree(workerWs);

    const entryBase = {
      version: 1 as const,
      resource_ref: "repo:ro",
      mapping_version: 1,
      worker_installation: "worker-node-1",
      canonical_root: workerWs,
      dev: wsStat.dev,
      ino: wsStat.ino,
      writable_allowed: false,
      expected_base_digest: baseSnap.tree_digest,
    };
    const mappingDigest = computeWorkspaceMappingDigest(entryBase);
    const entry: WorkspaceMappingEntryV1 = { ...entryBase, mapping_digest: mappingDigest };

    const sourceRef = store.stage(Buffer.from("console.log('ro');"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/javascript",
    });
    const delegation = buildDelegation(sourceRef);
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
      workerInstallation: "worker-node-1",
    };

    const prepared = await prepareWorkspace(
      access,
      {
        kind: "verified",
        resource_ref: "repo:ro",
        mapping_version: 1,
        mapping_digest: mappingDigest,
        writable: false,
      },
      {
        workerInstallation: "worker-node-1",
        mappings: [entry],
        lockStore,
      },
    );

    // Unauthorized file creation in read-only workspace must fail
    writeFileSync(join(workerWs, "rogue.txt"), "unauthorized write", { mode: 0o600 });
    await expect(
      collectWorkspaceResult(access, prepared.workspace, {
        baseSnapshot: prepared.baseSnapshot,
        localArtifacts: store,
        lockStore,
      }),
    ).rejects.toThrow(/Unauthorized file creation 'rogue.txt' in read-only workspace/);
  });
});
