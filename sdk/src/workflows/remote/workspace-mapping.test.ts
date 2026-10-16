import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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
import {
  OwnerStoreArtifactPort,
  RemoteArtifactCoordinator,
} from "./work-remote-artifacts.js";
import type { ExecutionAccessV1 } from "./work-remote-transport.js";
import { prepareWorkspaceInputBundle, scanWorkspaceTree } from "./workspace-input.js";
import { WorkspaceLockStore } from "./workspace-lock.js";
import {
  computeWorkspaceMappingDigest,
  prepareWorkspace,
  releaseWorkspace,
  verifyForLaunch,
  type WorkspaceMappingEntryV1,
} from "./workspace-mapping.js";

const roots: string[] = [];
const stores: { close(): void }[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-mapping-test-")));
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

describe("workspace-mapping", () => {
  it("refuses host-bound workspaces on remote workers and supports 'none' mode with filesystem restriction", async () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    stores.push(store);
    const sourceRef = store.stage(Buffer.from("export default () => ({});"), {
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

    // Host-bound workspace is explicitly refused
    await expect(
      prepareWorkspace(
        access,
        {
          kind: "host-bound",
          installation: "owner-1",
          path: root,
          device: 1,
          inode: 1,
        },
        { workerInstallation: "worker-node-1" },
      ),
    ).rejects.toThrow(/Host-bound workspace .* cannot execute on remote worker/);

    // Mode 'none' refuses tasks requiring filesystem access
    await expect(
      prepareWorkspace(
        access,
        { kind: "none", requires_filesystem: true },
        { workerInstallation: "worker-node-1" },
      ),
    ).rejects.toThrow(/Workspace mode 'none' cannot execute a task that requires filesystem/);

    // Mode 'none' succeeds when filesystem is not required
    const noneRes = await prepareWorkspace(
      access,
      { kind: "none" },
      { workerInstallation: "worker-node-1" },
    );
    expect(noneRes.workspace.mode).toBe("none");
    expect(noneRes.workspace.canonical_root).toBeNull();
    expect(noneRes.workspace.lock_id).toBeNull();
  });

  it("verifies and locks pre-provisioned 'verified' workspaces, rejecting stale versions, digest drift, symlinked runtimes, and unauthorized writes", async () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(store, lockStore);

    const wsDir = join(root, "verified-repo");
    mkdirSync(wsDir, { mode: 0o700 });
    writeFileSync(join(wsDir, "index.ts"), "export const x = 1;\n", { mode: 0o600 });
    const wsStat = statSync(wsDir);
    const initialSnap = scanWorkspaceTree(wsDir);

    const mappingBase = {
      version: 1 as const,
      resource_ref: "repo:barry",
      mapping_version: 3,
      worker_installation: "worker-node-1",
      canonical_root: wsDir,
      dev: wsStat.dev,
      ino: wsStat.ino,
      writable_allowed: false,
      expected_base_digest: initialSnap.tree_digest,
    };
    const mappingDigest = computeWorkspaceMappingDigest(mappingBase);
    const readOnlyEntry: WorkspaceMappingEntryV1 = {
      ...mappingBase,
      mapping_digest: mappingDigest,
    };

    const sourceRef = store.stage(Buffer.from("console.log(1);"), {
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

    // Stale mapping_version is rejected
    await expect(
      prepareWorkspace(
        access,
        {
          kind: "verified",
          resource_ref: "repo:barry",
          mapping_version: 2,
          mapping_digest: mappingDigest,
          writable: false,
        },
        {
          workerInstallation: "worker-node-1",
          mappings: [readOnlyEntry],
          lockStore,
        },
      ),
    ).rejects.toThrow(/version 3 does not match requested version 2/);

    // Requesting writable: true on read-only mapping is rejected
    await expect(
      prepareWorkspace(
        access,
        {
          kind: "verified",
          resource_ref: "repo:barry",
          mapping_version: 3,
          mapping_digest: mappingDigest,
          writable: true,
        },
        {
          workerInstallation: "worker-node-1",
          mappings: [readOnlyEntry],
          lockStore,
        },
      ),
    ).rejects.toThrow(/read-only and does not permit writable execution/);

    // Valid read-only verified workspace succeeds and acquires lock
    const prepared = await prepareWorkspace(
      access,
      {
        kind: "verified",
        resource_ref: "repo:barry",
        mapping_version: 3,
        mapping_digest: mappingDigest,
        expected_base_digest: initialSnap.tree_digest,
        writable: false,
      },
      {
        workerInstallation: "worker-node-1",
        mappings: [readOnlyEntry],
        lockStore,
      },
    );
    expect(prepared.workspace.mode).toBe("verified");
    expect(prepared.workspace.base_digest).toBe(initialSnap.tree_digest);
    expect(prepared.workspace.lock_id).toBeTruthy();

    // verifyForLaunch checks runtime availability and rejects symlinked runtime path
    const runtimeBin = join(root, "runtime-bin");
    writeFileSync(runtimeBin, "binary-bytes", { mode: 0o700 });
    const runtimeLink = join(root, "runtime-link");
    symlinkSync(runtimeBin, runtimeLink);

    await expect(
      verifyForLaunch(access, prepared.workspace, {
        workerInstallation: "worker-node-1",
        mappings: [readOnlyEntry],
        lockStore,
        requiredRuntimes: [{ path: runtimeLink, digest: "a".repeat(64), bytes: 12 }],
      }),
    ).rejects.toThrow(/traverses a symlink/);

    // verifyForLaunch succeeds when runtime and workspace are intact
    const verifiedHandle = await verifyForLaunch(access, prepared.workspace, {
      workerInstallation: "worker-node-1",
      mappings: [readOnlyEntry],
      lockStore,
      requiredRuntimes: [{ path: runtimeBin, digest: "a".repeat(64), bytes: 12 }],
    });
    expect(verifiedHandle.lock_id).toBe(prepared.workspace.lock_id);

    // Pre-launch mutation of workspace tree is caught by verifyForLaunch
    writeFileSync(join(wsDir, "index.ts"), "export const x = 999;\n", { mode: 0o600 });
    await expect(
      verifyForLaunch(access, prepared.workspace, {
        workerInstallation: "worker-node-1",
        mappings: [readOnlyEntry],
        lockStore,
      }),
    ).rejects.toThrow(/drifted from base_digest/);

    // Release workspace lock with positive 'not-started' settlement
    const released = releaseWorkspace(
      prepared.workspace,
      {
        version: 1,
        lock_id: prepared.workspace.lock_id!,
        binding: prepared.workspace.binding,
        physical_settlement: "not-started",
        future_input_fenced: true,
        settled_at: Date.now(),
      },
      lockStore,
    );
    expect(released?.state).toBe("released");
  });

  it("materializes and locks 'isolated' workspaces via RemoteArtifactCoordinator", async () => {
    const root = createTempRoot();
    const ownerStore = new WorkArtifactStore(join(root, "owner-cas"));
    const workerStore = new WorkArtifactStore(join(root, "worker-cas"));
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(ownerStore, workerStore, lockStore);

    const bundlePrep = prepareWorkspaceInputBundle({
      artifacts: ownerStore,
      resource_ref: "ws:isolated-1",
      files: [{ path: "hello.txt", content: "isolated content\n" }],
    });
    const sourceRef = ownerStore.stage(Buffer.from("console.log('iso');"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/javascript",
    });
    const delegation = buildDelegation(sourceRef);
    const port = new OwnerStoreArtifactPort({
      ownerStore,
      supplementalClosure: [bundlePrep.artifact],
    });
    const coordinator = new RemoteArtifactCoordinator({
      localArtifacts: workerStore,
      port,
      supplementalClosure: [bundlePrep.artifact],
    });
    const isolatedParent = join(root, "isolated-parent");
    mkdirSync(isolatedParent, { mode: 0o700 });

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
        kind: "isolated",
        resource_ref: "ws:isolated-1",
        input_bundle: bundlePrep.artifact,
        expected_base_digest: bundlePrep.bundle.base_digest,
        writable: true,
      },
      {
        workerInstallation: "worker-node-1",
        isolatedParentRoot: isolatedParent,
        lockStore,
        artifactCoordinator: coordinator,
      },
    );

    expect(prepared.workspace.mode).toBe("isolated");
    expect(prepared.workspace.base_digest).toBe(bundlePrep.bundle.base_digest);
    expect(prepared.workspace.canonical_root).toContain(isolatedParent);
  });
});
