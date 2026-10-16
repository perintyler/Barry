import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import type { ExecutorJournal } from "../executor-journal.js";
import { verifyWorkAgentProfile, type InstalledWorkAgent } from "../work-agent-profile.js";
import type { WorkArtifactRef, WorkArtifactStore } from "../work-artifacts.js";
import { executionBindingSchema } from "../work-contracts.js";
import { materializeProcessBundle } from "../work-process-bundle.js";
import {
  assertProcessProgramBundle,
  assertProcessProgramRuntime,
  assertProcessProgramScope,
} from "../work-process-program.js";
import {
  RemoteArtifactCoordinator,
  type RemoteArtifactCoordinatorOptions,
} from "./work-remote-artifacts.js";
import {
  assertExecutionAccessV1,
  extractExecutionBinding,
  sameExecutionBinding,
  type ExecutionAccessV1,
  type ExecutionBinding,
  type RemoteArtifactPortV1,
  type RemoteExecutionStage,
} from "./work-remote-transport.js";
import type { ScanWorkspaceTreeOptions, WorkspaceTreeSnapshotV1 } from "./workspace-input.js";
import {
  verifyCanonicalDirectoryIdentity,
  type WorkspaceLockRecordV1,
  type WorkspaceLockStore,
  type WorkspaceSettlementProofV1,
} from "./workspace-lock.js";
import {
  prepareWorkspace,
  releaseWorkspace,
  verifyForLaunch,
  type RemoteWorkspaceSelectionV1,
  type VerifiedWorkspaceV1,
  type WorkspaceMappingEntryV1,
  type WorkspaceRuntimeTargetV1,
} from "./workspace-mapping.js";
import {
  collectWorkspaceResult,
  type WorkspaceResultManifestV1,
} from "./workspace-result.js";

export type RemoteContainmentPosture =
  | "portable-pgid"
  | "node-permission-no-child"
  | "linux-cgroup-v2";

export interface PrepareRemoteLaunchOptionsV1 {
  readonly workerInstallation: string;
  readonly workspaceSelection: RemoteWorkspaceSelectionV1;
  readonly localArtifacts: WorkArtifactStore;
  readonly artifactPort: RemoteArtifactPortV1;
  readonly lockStore: WorkspaceLockStore;
  readonly stagingParentRoot: string;
  readonly isolatedParentRoot?: string;
  readonly mappings?: readonly WorkspaceMappingEntryV1[];
  readonly supplementalClosure?: readonly WorkArtifactRef[];
  readonly scanOptions?: ScanWorkspaceTreeOptions;
  readonly containmentPosture?: RemoteContainmentPosture;
  readonly now?: () => number;
}

export interface DiscardUnlaunchedOptionsV1 {
  readonly futureInputFenced?: boolean;
}

export interface PreparedRemoteResourcesV1 {
  readonly version: 1;
  readonly binding: ExecutionBinding;
  readonly executor_family: "process" | "structured-agent";
  readonly containment_posture: RemoteContainmentPosture;
  readonly workspace: VerifiedWorkspaceV1;
  readonly base_snapshot: WorkspaceTreeSnapshotV1 | null;
  readonly source_digest: string;
  readonly materialized_source_dir: string | null;
  readonly entrypoint_path: string | null;
  readonly runtime_path: string | null;
  readonly runtime_targets: readonly WorkspaceRuntimeTargetV1[];
  readonly verified_agent: InstalledWorkAgent | null;
  readonly closure_digests: readonly string[];
  readonly isLaunched: () => boolean;
  readonly verifyBeforeLaunch: (freshAccess?: ExecutionAccessV1) => Promise<VerifiedWorkspaceV1>;
  readonly markLaunched: () => void;
  readonly discardUnlaunched: (options?: DiscardUnlaunchedOptionsV1) => Promise<void>;
  readonly collectResult: (
    freshAccess?: ExecutionAccessV1,
    stage?: RemoteExecutionStage,
  ) => Promise<{
    readonly manifest: WorkspaceResultManifestV1;
    readonly manifestArtifact: WorkArtifactRef;
    readonly resultSnapshot: WorkspaceTreeSnapshotV1 | null;
  }>;
  readonly settleWorkspace: (
    settlement: WorkspaceSettlementProofV1,
  ) => WorkspaceLockRecordV1 | null;
}

function writeImmutableStagedFile(path: string, bytes: Buffer, mode: 0o400 | 0o500): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    }
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prepare verified remote code/runtime artifacts and a verified/locked workspace
 * for either a `process` or `structured-agent` execution on a remote worker.
 */
export async function prepareRemoteLaunch(
  access: ExecutionAccessV1,
  options: PrepareRemoteLaunchOptionsV1,
): Promise<PreparedRemoteResourcesV1> {
  const nowFn = options.now ?? Date.now;
  const delegation = await assertExecutionAccessV1(access, {
    now: nowFn,
    workerInstallation: options.workerInstallation,
    requireOnlineAuthority: true,
  });
  const binding = extractExecutionBinding(delegation);
  const { start } = delegation;

  if (!start.process_program && !start.agent_program) {
    throw new WorkflowError(
      "WorkRemoteProgramMissing",
      "Execution start must specify either process_program or agent_program.",
      400,
    );
  }

  const stagingParent = verifyCanonicalDirectoryIdentity(options.stagingParentRoot);
  if ((statSync(stagingParent.canonical_root).mode & 0o077) !== 0) {
    throw new WorkflowError(
      "WorkWorkspaceDirectoryInsecure",
      `Remote staging parent directory ${stagingParent.canonical_root} must have 0700 permissions.`,
      403,
    );
  }

  const extraClosure: WorkArtifactRef[] = [...(options.supplementalClosure ?? [])];
  if (options.workspaceSelection.kind === "isolated") {
    extraClosure.push(options.workspaceSelection.input_bundle);
  }

  const coordinatorOptions: RemoteArtifactCoordinatorOptions = {
    localArtifacts: options.localArtifacts,
    port: options.artifactPort,
    supplementalClosure: extraClosure,
    now: nowFn,
  };
  const coordinator = new RemoteArtifactCoordinator(coordinatorOptions);

  // 1. Download and verify all required closure artifacts into local CAS
  const closureMap = await coordinator.ensureExecutionClosure(access, extraClosure);
  const closureDigests = [...closureMap.keys()].sort();

  let materializedSourceDir: string | null = null;
  let entrypointPath: string | null = null;
  let runtimePath: string | null = null;
  const runtimeTargets: WorkspaceRuntimeTargetV1[] = [];
  let verifiedAgent: InstalledWorkAgent | null = null;
  const executorFamily: "process" | "structured-agent" = start.process_program
    ? "process"
    : "structured-agent";

  try {
    if (start.process_program) {
      const program = start.process_program;
      assertProcessProgramScope(program);
      assertProcessProgramRuntime(program);

      const sourceDir = join(stagingParent.canonical_root, `proc-src-${randomUUID()}`);
      mkdirSync(sourceDir, { recursive: false, mode: 0o700 });
      materializedSourceDir = verifyCanonicalDirectoryIdentity(sourceDir).canonical_root;

      const sourceBytes = options.localArtifacts.verify(start.source);
      if (program.bundle) {
        const bundleBytes = options.localArtifacts.verify(program.bundle.source);
        assertProcessProgramBundle(program, bundleBytes);
        const bundleDir = join(materializedSourceDir, "bundle");
        mkdirSync(bundleDir, { recursive: false, mode: 0o700 });
        materializeProcessBundle(bundleBytes, bundleDir);
        entrypointPath = join(bundleDir, program.bundle.entry);
      } else {
        const entryFile = join(materializedSourceDir, program.source_name);
        writeImmutableStagedFile(entryFile, sourceBytes, 0o500);
        entrypointPath = entryFile;
      }

      if (program.runtime_path) {
        runtimePath = program.runtime_path;
        runtimeTargets.push({
          path: program.runtime_path,
          digest: program.runtime.digest,
          bytes: program.runtime.bytes,
        });
      } else if (program.runtime.digest === start.source.digest && entrypointPath) {
        runtimePath = entrypointPath;
        runtimeTargets.push({
          path: entrypointPath,
          digest: program.runtime.digest,
          bytes: program.runtime.bytes,
        });
      } else {
        const runtimeBytes = options.localArtifacts.verify(program.runtime);
        const stagedRuntimePath = join(
          materializedSourceDir,
          `runtime-${program.runtime.digest.slice(0, 16)}`,
        );
        writeImmutableStagedFile(stagedRuntimePath, runtimeBytes, 0o500);
        runtimePath = stagedRuntimePath;
        runtimeTargets.push({
          path: stagedRuntimePath,
          digest: program.runtime.digest,
          bytes: program.runtime.bytes,
        });
      }

      for (const [label, cmd] of [
        ["preflight", program.commands?.preflight],
        ["postcondition", program.commands?.postcondition],
      ] as const) {
        if (!cmd) continue;
        const cmdBytes = options.localArtifacts.verify(cmd.runtime);
        if (cmd.runtime_path) {
          runtimeTargets.push({
            path: cmd.runtime_path,
            digest: cmd.runtime.digest,
            bytes: cmd.runtime.bytes,
          });
        } else {
          const cmdRuntimePath = join(
            materializedSourceDir,
            `cmd-${label}-${cmd.runtime.digest.slice(0, 12)}`,
          );
          if (!runtimeTargets.some(rt => rt.path === cmdRuntimePath)) {
            writeImmutableStagedFile(cmdRuntimePath, cmdBytes, 0o500);
            runtimeTargets.push({
              path: cmdRuntimePath,
              digest: cmd.runtime.digest,
              bytes: cmd.runtime.bytes,
            });
          }
        }
      }
    } else if (start.agent_program) {
      verifiedAgent = verifyWorkAgentProfile(
        start.agent_program.profile,
        options.localArtifacts,
      );
    }

    // 2. Prepare and lock the workspace
    const { workspace, baseSnapshot } = await prepareWorkspace(
      access,
      options.workspaceSelection,
      {
        workerInstallation: options.workerInstallation,
        ...(options.mappings ? { mappings: options.mappings } : {}),
        ...(options.isolatedParentRoot ? { isolatedParentRoot: options.isolatedParentRoot } : {}),
        lockStore: options.lockStore,
        artifactCoordinator: coordinator,
        ...(options.scanOptions ? { scanOptions: options.scanOptions } : {}),
        now: nowFn,
      },
    );

    let launched = false;
    let discarded = false;
    const containmentPosture: RemoteContainmentPosture =
      options.containmentPosture ?? "portable-pgid";

    return {
      version: 1,
      binding,
      executor_family: executorFamily,
      containment_posture: containmentPosture,
      workspace,
      base_snapshot: baseSnapshot,
      source_digest: start.source.digest,
      materialized_source_dir: materializedSourceDir,
      entrypoint_path: entrypointPath,
      runtime_path: runtimePath,
      runtime_targets: runtimeTargets,
      verified_agent: verifiedAgent,
      closure_digests: closureDigests,
      isLaunched: () => launched,
      verifyBeforeLaunch: async (freshAccess = access) => {
        if (discarded) {
          throw new WorkflowError(
            "WorkResourcesDiscarded",
            "Prepared remote resources have already been discarded.",
            409,
          );
        }
        return verifyForLaunch(freshAccess, workspace, {
          workerInstallation: options.workerInstallation,
          ...(options.mappings ? { mappings: options.mappings } : {}),
          lockStore: options.lockStore,
          requiredRuntimes: runtimeTargets,
          verifyCleanBaseDigest: true,
          ...(options.scanOptions ? { scanOptions: options.scanOptions } : {}),
          now: nowFn,
        });
      },
      markLaunched: () => {
        if (discarded) {
          throw new WorkflowError(
            "WorkResourcesDiscarded",
            "Cannot mark discarded remote resources as launched.",
            409,
          );
        }
        launched = true;
      },
      discardUnlaunched: async (discardOpts: DiscardUnlaunchedOptionsV1 = {}) => {
        if (launched) {
          throw new WorkflowError(
            "WorkAlreadyLaunched",
            "Cannot discard remote resources after launch may have begun; use settlement proof to release workspace custody.",
            409,
          );
        }
        if (discarded) return;
        discarded = true;

        if (materializedSourceDir) {
          try {
            rmSync(materializedSourceDir, { recursive: true, force: true });
          } catch {
            /* best effort cleanup of unlaunched private code staging dir */
          }
        }

        if (workspace.lock_id !== null && discardOpts.futureInputFenced === true) {
          releaseWorkspace(
            workspace,
            {
              version: 1,
              lock_id: workspace.lock_id,
              binding: workspace.binding,
              physical_settlement: "not-started",
              future_input_fenced: true,
              settled_at: nowFn(),
            },
            options.lockStore,
          );
          if (workspace.mode === "isolated" && workspace.canonical_root) {
            try {
              rmSync(workspace.canonical_root, { recursive: true, force: true });
            } catch {
              /* ignore isolated temp dir cleanup error */
            }
          }
        }
      },
      collectResult: async (freshAccess = access, stage = "publication") => {
        if (discarded) {
          throw new WorkflowError(
            "WorkResourcesDiscarded",
            "Cannot collect workspace result from discarded resources.",
            409,
          );
        }
        return collectWorkspaceResult(freshAccess, workspace, {
          baseSnapshot,
          localArtifacts: options.localArtifacts,
          artifactCoordinator: coordinator,
          lockStore: options.lockStore,
          stage,
          ...(options.scanOptions ? { scanOptions: options.scanOptions } : {}),
          now: nowFn,
        });
      },
      settleWorkspace: (settlement: WorkspaceSettlementProofV1) => {
        if (
          workspace.lock_id !== null &&
          settlement.physical_settlement !== "not-started" &&
          settlement.physical_settlement !== "ceased"
        ) {
          options.lockStore.markUnknownCustody(
            workspace.lock_id,
            workspace.binding,
            `Physical settlement is '${settlement.physical_settlement}' under ${containmentPosture} containment.`,
          );
        }
        const released = releaseWorkspace(workspace, settlement, options.lockStore);
        if (
          released &&
          released.state === "released" &&
          workspace.mode === "isolated" &&
          workspace.canonical_root
        ) {
          try {
            rmSync(workspace.canonical_root, { recursive: true, force: true });
          } catch {
            /* best effort cleanup after positive settlement */
          }
        }
        if (released && released.state === "released" && materializedSourceDir) {
          try {
            rmSync(materializedSourceDir, { recursive: true, force: true });
          } catch {
            /* best effort cleanup after positive settlement */
          }
        }
        return released;
      },
    };
  } catch (error) {
    if (materializedSourceDir) {
      try {
        rmSync(materializedSourceDir, { recursive: true, force: true });
      } catch {
        /* preserve original error */
      }
    }
    throw error;
  }
}

/**
 * Reconcile active workspace locks against `ExecutorJournal` observations across
 * worker restarts or transport disconnects without creating new execution effects.
 */
export function recoverRemoteWorkspaceCustody(options: {
  readonly journal: ExecutorJournal;
  readonly lockStore: WorkspaceLockStore;
  readonly fencedBindings?: ReadonlySet<string>;
  readonly now?: () => number;
}): {
  readonly released: readonly WorkspaceLockRecordV1[];
  readonly retainedUnknown: readonly WorkspaceLockRecordV1[];
} {
  const nowFn = options.now ?? Date.now;
  const released: WorkspaceLockRecordV1[] = [];
  const retainedUnknown: WorkspaceLockRecordV1[] = [];

  for (const lock of options.lockStore.listActive()) {
    const observation = options.journal.inspect(lock.binding);
    if (!observation) {
      const updated = options.lockStore.markUnknownCustody(
        lock.lock_id,
        lock.binding,
        "No matching executor journal observation found during recovery.",
      );
      retainedUnknown.push(updated);
      continue;
    }

    const obsBinding = executionBindingSchema.parse({
      version: observation.version,
      owner: observation.owner,
      work_id: observation.work_id,
      workflow_id: observation.workflow_id,
      activity_id: observation.activity_id,
      attempt_id: observation.attempt_id,
      request_hash: observation.request_hash,
      plan_digest: observation.plan_digest,
      grant_ref: observation.grant_ref,
      grant_revision: observation.grant_revision,
      source: observation.source,
      execution_fence: observation.execution_fence,
      deadline: observation.deadline,
    });

    if (!sameExecutionBinding(obsBinding, lock.binding)) {
      const updated = options.lockStore.markUnknownCustody(
        lock.lock_id,
        lock.binding,
        "Executor journal observation binding differs from workspace lock binding.",
      );
      retainedUnknown.push(updated);
      continue;
    }

    const futureInputFenced =
      observation.stage === "terminal" ||
      observation.receipt_ref !== null ||
      (options.fencedBindings?.has(lock.binding.attempt_id) ?? false);

    if (
      (observation.physical_state === "not-started" ||
        observation.physical_state === "ceased") &&
      futureInputFenced
    ) {
      const rel = options.lockStore.release({
        version: 1,
        lock_id: lock.lock_id,
        binding: lock.binding,
        physical_settlement: observation.physical_state,
        future_input_fenced: true,
        settled_at: nowFn(),
        observation,
      });
      released.push(rel);
    } else {
      const updated = options.lockStore.markUnknownCustody(
        lock.lock_id,
        lock.binding,
        `Recovered execution physical_state='${observation.physical_state}', stage='${observation.stage}', futureInputFenced=${String(futureInputFenced)}.`,
      );
      retainedUnknown.push(updated);
    }
  }

  return { released, retainedUnknown };
}
