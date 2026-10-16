import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { ExecutorJournal } from "../executor-journal.js";
import type { WorkOwnerConnection } from "../work-activity-worker.js";
import { WorkArtifactStore } from "../work-artifacts.js";
import { workGrantSchema, workPlanHash, workPlanSchema } from "../work-contracts.js";
import {
  workExecutionDelegationSchema,
  type WorkExecutionDelegation,
} from "../work-execution-delegation.js";
import { prepareProcessBundle } from "../work-process-bundle.js";
import { OwnerStoreArtifactPort } from "./work-remote-artifacts.js";
import {
  prepareRemoteLaunch,
  recoverRemoteWorkspaceCustody,
} from "./work-remote-host.js";
import type { ExecutionAccessV1 } from "./work-remote-transport.js";
import { prepareWorkspaceInputBundle, scanWorkspaceTree } from "./workspace-input.js";
import { WorkspaceLockStore } from "./workspace-lock.js";
import {
  computeWorkspaceMappingDigest,
  type WorkspaceMappingEntryV1,
} from "./workspace-mapping.js";

const roots: string[] = [];
const stores: { close(): void }[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "work-remote-host-test-")));
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

describe("work-remote-host", () => {
  it("prepares remote process launch with bundle and isolated workspace, enforces discardUnlaunched vs markLaunched, and collects results", async () => {
    const root = createTempRoot();
    const ownerArtifacts = new WorkArtifactStore(join(root, "owner-cas"));
    const workerArtifacts = new WorkArtifactStore(join(root, "worker-cas"));
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(ownerArtifacts, workerArtifacts, lockStore);

    const srcRoot = join(root, "bundle-src");
    mkdirSync(srcRoot, { mode: 0o700 });
    const entryFile = join(srcRoot, "main.js");
    const helperFile = join(srcRoot, "helper.js");
    writeFileSync(entryFile, "import './helper.js'; console.log(JSON.stringify({ok:true}));\n", {
      mode: 0o700,
    });
    writeFileSync(helperFile, "export const h = 1;\n", { mode: 0o600 });

    const bundle = prepareProcessBundle({
      artifacts: ownerArtifacts,
      allowedRoots: [srcRoot],
      files: [
        { path: "main.js", source: entryFile },
        { path: "helper.js", source: helperFile },
      ],
    });
    const entryRef = ownerArtifacts.stage(
      Buffer.from("import './helper.js'; console.log(JSON.stringify({ok:true}));\n"),
      {
        purpose: "source",
        owner_identity: null,
        media_type: "application/octet-stream",
      },
    );
    const runtimeRef = ownerArtifacts.stage(Buffer.from("#!/bin/sh\n"), {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });

    const inputBundle = prepareWorkspaceInputBundle({
      artifacts: ownerArtifacts,
      resource_ref: "ws:iso-proc",
      files: [{ path: "input.txt", content: "initial\n" }],
    });

    const now = Date.now();
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
    const processProgram = {
      activity_type: "proc-bundle-act",
      source_digest: entryRef.digest,
      installation: "owner-1",
      scope,
      bundle: { source: bundle.source, entry: "main.js" },
      runtime: runtimeRef,
      credential_owner: { kind: "none" as const },
      argv: [{ file: "main.js", format: "path" as const }],
      source_name: "main.js",
      cwd: { path: srcRoot, device: 1, inode: 1 },
      env: {},
      secret_names: [],
      output: "json" as const,
    };
    const plan = workPlanSchema.parse({
      version: 2,
      definition: { kind: "job", reference: "proc-bundle-act" },
      workflow: {
        type: "proc-wf",
        version: "1",
        artifact_digest: entryRef.digest,
        runtime_abi: "v1",
        input_digest: "3".repeat(64),
      },
      source_closure: [entryRef, runtimeRef, bundle.source],
      grant_ref: "grant-1",
      grant_revision: 1,
      executor_generation: "v2",
      grant_digest: boundFingerprint(grant),
      execution_profile: "portable",
      effect_policy: { class: "non-repeatable", max_attempts: 1 },
      validation: { mode: "none" },
      process_program: processProgram,
      resources: {
        executor: "process",
        lane: "unscheduled",
        logical_reservation: "logical-1",
        host_reservation: null,
        endpoint: null,
      },
      workspace: {
        kind: "isolated",
        input_bundle: inputBundle.artifact,
        publication_contract: "patch-v1",
      },
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
    const admissionRequestHash = "5".repeat(64);
    const inputs = {};
    const requestHash = boundFingerprint({
      admission: admissionRequestHash,
      activity: "act-1",
      type: "proc-bundle-act",
      input: inputs,
    });
    const delegation: WorkExecutionDelegation = workExecutionDelegationSchema.parse({
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
        source: entryRef,
        execution_fence: 1,
        deadline: now + 60_000,
        launch_authorized: true,
        inputs,
        effect_policy: plan.effect_policy,
        resources: { ...plan.resources, host_reservation: "host-1" },
        executor_generation: "v2",
        validation: { mode: "none" },
        process_program: processProgram,
        activity_type: "proc-bundle-act",
        output_identity: "id-1",
      },
    });

    const stagingParent = join(root, "staging");
    const isolatedParent = join(root, "isolated");
    mkdirSync(stagingParent, { mode: 0o700 });
    mkdirSync(isolatedParent, { mode: 0o700 });

    const port = new OwnerStoreArtifactPort({ ownerStore: ownerArtifacts });
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
      workerInstallation: "worker-node-1",
    };

    const prepared = await prepareRemoteLaunch(access, {
      workerInstallation: "worker-node-1",
      workspaceSelection: {
        kind: "isolated",
        resource_ref: "ws:iso-proc",
        input_bundle: inputBundle.artifact,
        expected_base_digest: inputBundle.bundle.base_digest,
        writable: true,
      },
      localArtifacts: workerArtifacts,
      artifactPort: port,
      lockStore,
      stagingParentRoot: stagingParent,
      isolatedParentRoot: isolatedParent,
    });

    expect(prepared.executor_family).toBe("process");
    expect(prepared.entrypoint_path).toBeTruthy();
    expect(existsSync(prepared.entrypoint_path!)).toBe(true);

    // Verify before launch succeeds
    await expect(prepared.verifyBeforeLaunch()).resolves.toBeDefined();

    // Mark launched -> discardUnlaunched must now throw 409 WorkAlreadyLaunched and preserve everything
    prepared.markLaunched();
    expect(prepared.isLaunched()).toBe(true);
    await expect(prepared.discardUnlaunched({ futureInputFenced: true })).rejects.toThrow(
      /Cannot discard remote resources after launch may have begun/,
    );

    // Simulate execution writing output file in isolated workspace
    writeFileSync(join(prepared.workspace.canonical_root!, "output.txt"), "produced\n", {
      mode: 0o600,
    });

    const result = await prepared.collectResult();
    expect(result.manifest.changes).toHaveLength(1);
    expect(result.manifest.changes[0]?.path).toBe("output.txt");
    expect(ownerArtifacts.verify(result.manifestArtifact)).toBeDefined();

    // F2 containment accounting: settling with 'unknown' physical_settlement marks lock as 'unknown' and refuses release
    expect(() =>
      prepared.settleWorkspace({
        version: 1,
        lock_id: prepared.workspace.lock_id!,
        binding: prepared.binding,
        physical_settlement: "unknown",
        future_input_fenced: true,
        settled_at: Date.now(),
      }),
    ).toThrow(/cannot be released while physical_settlement is 'unknown'/);
    expect(lockStore.inspect(prepared.workspace.lock_id!)?.state).toBe("unknown");

    // Settling with 'ceased' + future_input_fenced releases the lock and cleans up isolated workspace
    const isoRoot = prepared.workspace.canonical_root!;
    const released = prepared.settleWorkspace({
      version: 1,
      lock_id: prepared.workspace.lock_id!,
      binding: prepared.binding,
      physical_settlement: "ceased",
      future_input_fenced: true,
      settled_at: Date.now(),
    });
    expect(released?.state).toBe("released");
    expect(existsSync(isoRoot)).toBe(false);
  });

  it("recovers workspace locks across worker restart via recoverRemoteWorkspaceCustody without creating new effects", () => {
    const root = createTempRoot();
    const artifacts = new WorkArtifactStore(join(root, "cas"));
    const journal = new ExecutorJournal({
      path: join(root, "journal.sqlite"),
      installation: "worker-node-1",
      artifacts,
    });
    const lockStore = new WorkspaceLockStore({
      path: join(root, "locks.sqlite"),
      installation: "worker-node-1",
    });
    stores.push(artifacts, journal, lockStore);

    const ws1 = join(root, "ws1");
    const ws2 = join(root, "ws2");
    mkdirSync(ws1, { mode: 0o700 });
    mkdirSync(ws2, { mode: 0o700 });
    const stat1 = statSync(ws1);
    const stat2 = statSync(ws2);

    const now = Date.now();
    const sourceRef = artifacts.stage(Buffer.from("code"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/javascript",
    });

    const binding1 = {
      version: 2 as const,
      owner: "owner-1",
      work_id: "work-1",
      workflow_id: "wf-1",
      activity_id: "act-1",
      attempt_id: "att-1",
      request_hash: "a".repeat(64),
      plan_digest: "b".repeat(64),
      grant_ref: "grant-1",
      grant_revision: 1,
      source: sourceRef,
      execution_fence: 1,
      deadline: now + 60_000,
    };
    const binding2 = {
      ...binding1,
      work_id: "work-2",
      workflow_id: "wf-2",
      activity_id: "act-2",
      attempt_id: "att-2",
    };

    // Record binding1 in journal as never launched (not-started)
    journal.start({
      ...binding1,
      launch_authorized: true,
      inputs: {},
      effect_policy: { class: "non-repeatable", max_attempts: 1 },
      resources: {
        executor: "process",
        lane: "unscheduled",
        logical_reservation: "l1",
        host_reservation: "h1",
        endpoint: null,
      },
      executor_generation: "v2",
    });

    const lock1 = lockStore.acquire({
      resource_ref: "repo:1",
      mapping_version: 1,
      mapping_digest: "d".repeat(64),
      canonical_root: ws1,
      dev: stat1.dev,
      ino: stat1.ino,
      binding: binding1,
    });
    // Lock2 has no journal entry (or unverified state) -> must be retained in unknown custody!
    const lock2 = lockStore.acquire({
      resource_ref: "repo:2",
      mapping_version: 1,
      mapping_digest: "e".repeat(64),
      canonical_root: ws2,
      dev: stat2.dev,
      ino: stat2.ino,
      binding: binding2,
    });

    const recovery = recoverRemoteWorkspaceCustody({
      journal,
      lockStore,
      fencedBindings: new Set(["att-1"]),
    });

    expect(recovery.released.map(r => r.lock_id)).toEqual([lock1.lock_id]);
    expect(recovery.retainedUnknown.map(r => r.lock_id)).toEqual([lock2.lock_id]);
    expect(lockStore.inspect(lock1.lock_id)?.state).toBe("released");
    expect(lockStore.inspect(lock2.lock_id)?.state).toBe("unknown");
  });
});
