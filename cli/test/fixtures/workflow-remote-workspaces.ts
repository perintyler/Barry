import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import {
  ExecutorJournal,
  HttpRemoteArtifactTransport,
  WorkArtifactStore,
  WorkflowError,
  WorkspaceLockStore,
  applyWorkspaceResultStaged,
  computeWorkspaceMappingDigest,
  createRemoteArtifactHttpHandler,
  extractExecutionBinding,
  prepareProcessBundle,
  prepareRemoteLaunch,
  prepareWorkspaceInputBundle,
  recoverRemoteWorkspaceCustody,
  sameExecutionBinding,
  scanWorkspaceTree,
  verifyWorkspacePublicationConflicts,
  workAgentProfileSchema,
  workExecutionDelegationSchema,
  workGrantSchema,
  workPlanHash,
  workPlanSchema,
  type ExecutionAccessV1,
  type RemoteWorkspaceSelectionV1,
  type WorkArtifactRef,
  type WorkExecutionDelegation,
  type WorkspaceMappingEntryV1,
} from "@barry-rocks/sdk/internal/workflows";

export interface WorkflowRemoteWorkspaceFixtureOptions {
  readonly dropFirstStageResponse?: boolean;
  readonly corruptFirstDownload?: boolean;
}

/**
 * Real loopback HTTP + separate owner/worker CAS + durable SQLite ExecutorJournal
 * and WorkspaceLockStore fixture for qualifying P6.3/P6.4 remote execution and
 * verified workspaces with P6.6 failure injection.
 */
export async function createWorkflowRemoteWorkspaceFixture(
  options: WorkflowRemoteWorkspaceFixtureOptions = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-remote-workspaces-")));
  const ownerCasDir = join(root, "owner-cas");
  const workerCasDir = join(root, "worker-cas");
  const workerStagingDir = join(root, "worker-staging");
  const workerIsolatedDir = join(root, "worker-isolated");
  const verifiedCheckoutDir = join(root, "verified-checkout");
  const publicationTargetDir = join(root, "publication-target");
  const bundleSrcDir = join(root, "bundle-source");

  for (const dir of [
    ownerCasDir,
    workerCasDir,
    workerStagingDir,
    workerIsolatedDir,
    verifiedCheckoutDir,
    publicationTargetDir,
    bundleSrcDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Seed initial files in verifiedCheckoutDir and publicationTargetDir
  for (const dir of [verifiedCheckoutDir, publicationTargetDir]) {
    mkdirSync(join(dir, "src"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "README.md"), "# Barry Remote Workspace\n", { mode: 0o600 });
    writeFileSync(join(dir, "src/index.ts"), "export const version = 1;\n", { mode: 0o600 });
  }

  const ownerArtifacts = new WorkArtifactStore(ownerCasDir);
  const workerArtifacts = new WorkArtifactStore(workerCasDir);
  const workerInstallation = "remote-worker-node-a";
  const ownerInstallation = "owner-node-main";
  const workerCredential = "barry_wk_remote_fixture_credential_token";
  const credentialFile = join(root, "worker.cred");
  writeFileSync(credentialFile, `${workerCredential}\n`, { mode: 0o600 });

  const lockStorePath = join(root, "workspace-locks.sqlite");
  const journalPath = join(root, "worker-executor.sqlite");
  let lockStore = new WorkspaceLockStore({
    path: lockStorePath,
    installation: workerInstallation,
  });
  let journal = new ExecutorJournal({
    path: journalPath,
    installation: workerInstallation,
    artifacts: workerArtifacts,
  });

  // Seed process bundle and runtime in owner CAS (NOT in worker CAS)
  const entryPath = join(bundleSrcDir, "runner.js");
  writeFileSync(
    entryPath,
    "console.log(JSON.stringify({ executed: true }));\n",
    { mode: 0o700 },
  );
  const processBundle = prepareProcessBundle({
    artifacts: ownerArtifacts,
    allowedRoots: [bundleSrcDir],
    files: [{ path: "runner.js", source: entryPath }],
  });
  const processSourceRef = ownerArtifacts.stage(
    Buffer.from("console.log(JSON.stringify({ executed: true }));\n"),
    {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    },
  );
  const processRuntimeRef = ownerArtifacts.stage(Buffer.from("#!/bin/sh\necho runtime\n"), {
    purpose: "source",
    owner_identity: null,
    media_type: "application/octet-stream",
  });

  // Seed structured-agent profile and runtime chunks in owner CAS (NOT in worker CAS)
  const agentChunkBytes = Buffer.from("pi-harness-chunk-v1");
  const agentChunkRef = ownerArtifacts.stage(agentChunkBytes, {
    purpose: "source",
    owner_identity: null,
    media_type: "application/octet-stream",
  });
  const agentManifestBytes = Buffer.from(
    JSON.stringify({
      version: 2,
      protocol: 1,
      harness: "pi",
      chunks: [{ digest: agentChunkRef.digest, bytes: agentChunkRef.bytes }],
      files: [
        { path: "a", storage: { chunk: agentChunkRef.digest } },
        { path: "b", storage: { chunk: agentChunkRef.digest } },
        { path: "c", storage: { chunk: agentChunkRef.digest } },
        { path: "d", storage: { chunk: agentChunkRef.digest } },
      ],
    }),
    "utf8",
  );
  const agentManifestRef = ownerArtifacts.stage(agentManifestBytes, {
    purpose: "source",
    owner_identity: null,
    media_type: "application/octet-stream",
  });
  const agentProfile = workAgentProfileSchema.parse({
    version: 1,
    installation: ownerInstallation,
    reference: "fixture:remote-agent",
    title: "Remote Workspace Structured Agent",
    harness: "pi",
    model: "openai/probe",
    endpoint: "http://127.0.0.1:4310/v1",
    generation: "00000000-0000-4000-8000-000000000099",
    record_hash: "9".repeat(64),
    runtime: {
      version: 1,
      digest: agentManifestRef.digest,
      bytes: agentManifestRef.bytes,
      protocol: 1,
    },
    provider: {},
    cwd: { path: verifiedCheckoutDir, device: 1, inode: 1 },
    validation: { mode: "none" },
    prompt: "Update workspace safely.",
    max_turns: 1,
    execution_budget_ms: 60_000,
    budget_policy: "reservation-only",
    endpoint_resource: "fixture-ep",
    max_input_tokens: 2048,
    max_output_tokens: 4096,
    max_cost: 0.1,
    sources: [agentManifestRef, agentChunkRef],
  });
  const agentProfileRef = ownerArtifacts.stage(
    Buffer.from(JSON.stringify(agentProfile), "utf8"),
    {
      purpose: "source",
      owner_identity: null,
      media_type: "application/json",
    },
  );

  // Seed isolated workspace input bundle in owner CAS
  const isolatedInputBundle = prepareWorkspaceInputBundle({
    artifacts: ownerArtifacts,
    resource_ref: "repo:isolated-work",
    files: [
      { path: "README.md", content: "# Isolated Workspace\n" },
      { path: "src/task.ts", content: "export const status = 'pending';\n" },
    ],
  });

  const activeDelegations = new Map<string, WorkExecutionDelegation>();
  const supplementalClosure: WorkArtifactRef[] = [
    agentManifestRef,
    agentChunkRef,
    isolatedInputBundle.artifact,
  ];
  let effectOnline = true;
  let credentialRevoked = false;
  let remainingDroppedStages = options.dropFirstStageResponse ? 1 : 0;

  const artifactHandler = createRemoteArtifactHttpHandler({
    artifacts: ownerArtifacts,
    chunkBytes: 8192,
    authenticateWorker: token =>
      !credentialRevoked && token === workerCredential ? workerInstallation : null,
    authorizeExecution: (_workerId, binding, planDigest) => {
      const delegation = activeDelegations.get(binding.attempt_id);
      if (!delegation) {
        throw new WorkflowError("WorkExecutionNotFound", "Unknown execution attempt.", 404);
      }
      const expected = extractExecutionBinding(delegation);
      if (!sameExecutionBinding(binding, expected) || planDigest !== expected.plan_digest) {
        throw new WorkflowError("ExecutorBindingConflict", "Execution binding mismatch.", 409);
      }
      return { delegation, supplementalClosure };
    },
  });

  const server: Server = createServer(async (req, res) => {
    if (remainingDroppedStages > 0 && req.url === "/api/worker/artifacts/stage") {
      remainingDroppedStages--;
      res.writeHead = () => res;
      res.end = () => {
        res.socket?.destroy();
        return res;
      };
      await artifactHandler(req, res);
      return;
    }
    const handled = await artifactHandler(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ownerUrl = `http://127.0.0.1:${port}/`;

  const transport = new HttpRemoteArtifactTransport({
    ownerUrl,
    credential: () => workerCredential,
    chunkBytes: 8192,
    supplementalClosure,
  });

  const connection: ExecutionAccessV1["connection"] = {
    advertise: async () => {},
    claim: async () => null,
    heartbeat: async () => effectOnline,
    effect: async () => effectOnline,
    observe: async () => ({ status: "accepted" }),
    complete: async () => ({ status: "accepted" }),
  };

  function getVerifiedMappingEntry(writableAllowed = true, mappingVersion = 1): WorkspaceMappingEntryV1 {
    const st = statSync(verifiedCheckoutDir);
    const snap = scanWorkspaceTree(verifiedCheckoutDir);
    const base = {
      version: 1 as const,
      resource_ref: "repo:verified-main",
      mapping_version: mappingVersion,
      worker_installation: workerInstallation,
      canonical_root: verifiedCheckoutDir,
      dev: st.dev,
      ino: st.ino,
      writable_allowed: writableAllowed,
      expected_base_digest: snap.tree_digest,
    };
    return {
      ...base,
      mapping_digest: computeWorkspaceMappingDigest(base),
    };
  }

  function createDelegation(params: {
    family: "process" | "structured-agent";
    attemptId: string;
    workId?: string;
    workflowId?: string;
    activityId?: string;
    fence?: number;
  }): ExecutionAccessV1 {
    const now = Date.now();
    const workId = params.workId ?? `work-${params.attemptId}`;
    const workflowId = params.workflowId ?? `wf-${params.attemptId}`;
    const activityId = params.activityId ?? `act-${params.attemptId}`;
    const fence = params.fence ?? 1;
    const rawScope = {
      identity: "id-remote-1",
      traits: ["work-control"],
      bound: null,
      tools:
        params.family === "process"
          ? { "bash:Bash": "write" as const }
          : ({} as Record<string, "read" | "write">),
      ...(params.family === "process"
        ? { contracts: { "bash:Bash": "b".repeat(64) } }
        : {}),
    };
    const scope = { ...rawScope, fingerprint: boundFingerprint(rawScope) };
    const namespace = {
      installation: ownerInstallation,
      principal_kind: "identity" as const,
      principal_id: "actor-remote-1",
      identity_id: "id-remote-1",
      caller_session_id: "sess-remote-1",
    };
    const origin = {
      entry_point: "api",
      trigger: "invocation" as const,
      caller_session_id: "sess-remote-1",
    };
    const grant = workGrantSchema.parse({
      version: 2,
      grant_ref: `grant-${params.attemptId}`,
      revision: 1,
      namespace,
      authorizer: "actor-remote-1",
      created_by: "actor-remote-1",
      approved_at: now,
      original_caller_ceiling: scope,
      effective_scope: scope,
      definition_bounds_digest: "2".repeat(64),
      policy_revision: "pol-1",
    });

    if (params.family === "process") {
      const processProgram = {
        activity_type: "remote-proc-act",
        source_digest: processSourceRef.digest,
        installation: ownerInstallation,
        scope,
        bundle: { source: processBundle.source, entry: "runner.js" },
        runtime: processRuntimeRef,
        credential_owner: { kind: "none" as const },
        argv: [{ file: "runner.js", format: "path" as const }],
        source_name: "runner.js",
        cwd: { path: verifiedCheckoutDir, device: 1, inode: 1 },
        env: {},
        secret_names: [],
        output: "json" as const,
      };
      const plan = workPlanSchema.parse({
        version: 2,
        definition: { kind: "job", reference: "remote-proc-act" },
        workflow: {
          type: "remote-proc-wf",
          version: "1",
          artifact_digest: processSourceRef.digest,
          runtime_abi: "v1",
          input_digest: "3".repeat(64),
        },
        source_closure: [processSourceRef, processRuntimeRef, processBundle.source],
        grant_ref: grant.grant_ref,
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
      const admissionRequestHash = "7".repeat(64);
      const inputs = {};
      const requestHash = boundFingerprint({
        admission: admissionRequestHash,
        activity: activityId,
        type: "remote-proc-act",
        input: inputs,
      });
      const delegation = workExecutionDelegationSchema.parse({
        version: 1,
        admission_request_hash: admissionRequestHash,
        namespace,
        origin,
        grant,
        plan,
        start: {
          version: 2,
          owner: ownerInstallation,
          work_id: workId,
          workflow_id: workflowId,
          activity_id: activityId,
          attempt_id: params.attemptId,
          request_hash: requestHash,
          plan_digest: planDigest,
          grant_ref: grant.grant_ref,
          grant_revision: 1,
          source: processSourceRef,
          execution_fence: fence,
          deadline: now + 60_000,
          launch_authorized: true,
          inputs,
          effect_policy: plan.effect_policy,
          resources: { ...plan.resources, host_reservation: "host-res-1" },
          executor_generation: "v2",
          validation: { mode: "none" },
          process_program: processProgram,
          activity_type: "remote-proc-act",
          output_identity: "id-remote-1",
        },
      });
      activeDelegations.set(params.attemptId, delegation);
      return {
        version: 1,
        delegation,
        connection,
        signal: new AbortController().signal,
        workerInstallation,
      };
    }

    const agentProgram = {
      activity_type: `agents:${agentProfileRef.digest}@1`,
      source_digest: agentProfileRef.digest,
      installation: ownerInstallation,
      scope,
      profile: agentProfileRef,
    };
    const plan = workPlanSchema.parse({
      version: 2,
      definition: {
        kind: "action",
        reference: "fixture:remote-agent",
        catalog_namespace: "fixture",
      },
      workflow: {
        type: "remote-agent-wf",
        version: "1",
        artifact_digest: agentProfileRef.digest,
        runtime_abi: "v1",
        input_digest: "4".repeat(64),
      },
      source_closure: [agentProfileRef],
      grant_ref: grant.grant_ref,
      grant_revision: 1,
      executor_generation: "v2",
      grant_digest: boundFingerprint(grant),
      execution_profile: "portable",
      effect_policy: { class: "non-repeatable", max_attempts: 1 },
      validation: { mode: "none" },
      agent_program: agentProgram,
      resources: {
        executor: "agent",
        lane: "unscheduled",
        logical_reservation: "logical-1",
        host_reservation: null,
        endpoint: {
          broker: "broker-1",
          endpoint: "fixture-ep",
          reservation: null,
          model: "openai/probe",
          max_input_tokens: 2048,
          max_output_tokens: 4096,
          max_cost: 0.1,
        },
      },
      workspace: { kind: "none" },
      selection: {
        requested_model: "openai/probe",
        resolved_model: "openai/probe",
        endpoint: "fixture-ep",
        requested_harness: "pi",
        resolved_harness: "pi",
        provenance: "profile",
      },
      execution_budget_ms: 60_000,
      dispatch_budget_ms: 60_000,
    });
    const planDigest = workPlanHash(plan);
    const admissionRequestHash = "8".repeat(64);
    const inputs = {};
    const requestHash = boundFingerprint({
      admission: admissionRequestHash,
      activity: activityId,
      type: agentProgram.activity_type,
      input: inputs,
    });
    const delegation = workExecutionDelegationSchema.parse({
      version: 1,
      admission_request_hash: admissionRequestHash,
      namespace,
      origin,
      grant,
      plan,
      start: {
        version: 2,
        owner: ownerInstallation,
        work_id: workId,
        workflow_id: workflowId,
        activity_id: activityId,
        attempt_id: params.attemptId,
        request_hash: requestHash,
        plan_digest: planDigest,
        grant_ref: grant.grant_ref,
        grant_revision: 1,
        source: agentProfileRef,
        execution_fence: fence,
        deadline: now + 60_000,
        launch_authorized: true,
        inputs,
        effect_policy: plan.effect_policy,
        resources: {
          ...plan.resources,
          host_reservation: "host-res-1",
          endpoint: { ...plan.resources.endpoint!, reservation: "ep-res-1" },
        },
        executor_generation: "v2",
        validation: { mode: "none" },
        agent_program: agentProgram,
        activity_type: agentProgram.activity_type,
        output_identity: "id-remote-1",
      },
    });
    activeDelegations.set(params.attemptId, delegation);
    return {
      version: 1,
      delegation,
      connection,
      signal: new AbortController().signal,
      workerInstallation,
    };
  }

  return {
    root,
    ownerInstallation,
    workerInstallation,
    ownerArtifacts,
    workerArtifacts,
    verifiedCheckoutDir,
    publicationTargetDir,
    workerStagingDir,
    workerIsolatedDir,
    isolatedInputBundle,
    transport,
    get lockStore() {
      return lockStore;
    },
    get journal() {
      return journal;
    },
    setEffectOnline(online: boolean) {
      effectOnline = online;
    },
    setCredentialRevoked(revoked: boolean) {
      credentialRevoked = revoked;
    },
    getVerifiedMappingEntry,
    createDelegation,
    async prepareLaunch(
      access: ExecutionAccessV1,
      workspaceSelection: RemoteWorkspaceSelectionV1,
      mappings: WorkspaceMappingEntryV1[] = [getVerifiedMappingEntry(true, 1)],
    ) {
      return prepareRemoteLaunch(access, {
        workerInstallation,
        workspaceSelection,
        localArtifacts: workerArtifacts,
        artifactPort: transport,
        lockStore,
        stagingParentRoot: workerStagingDir,
        isolatedParentRoot: workerIsolatedDir,
        mappings,
        supplementalClosure,
      });
    },
    restartWorkerStores(fencedBindings?: ReadonlySet<string>) {
      lockStore.close();
      journal.close();
      lockStore = new WorkspaceLockStore({
        path: lockStorePath,
        installation: workerInstallation,
      });
      journal = new ExecutorJournal({
        path: journalPath,
        installation: workerInstallation,
        artifacts: workerArtifacts,
      });
      return recoverRemoteWorkspaceCustody({
        journal,
        lockStore,
        ...(fencedBindings ? { fencedBindings } : {}),
      });
    },
    verifyConflicts: verifyWorkspacePublicationConflicts,
    applyResultStaged: applyWorkspaceResultStaged,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      lockStore.close();
      journal.close();
      workerArtifacts.close();
      ownerArtifacts.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
