import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { installationSecrets } from "../services/installation-secrets.js";
import { inspectArtifact } from "./artifacts.js";
import { WorkflowError } from "./errors.js";
import { connectWorkOwnerV3 } from "./protocol.js";
import { readBoundedFile } from "./read-bounded.js";
import {
  OwnerStoreArtifactPort,
  RemoteArtifactCoordinator,
  type OwnerStoreArtifactPortOptions,
  type RemoteArtifactCoordinatorOptions,
} from "./remote/work-remote-artifacts.js";
import {
  prepareRemoteLaunch,
  recoverRemoteWorkspaceCustody,
  type DiscardUnlaunchedOptionsV1,
  type PrepareRemoteLaunchOptionsV1,
  type PreparedRemoteResourcesV1,
  type RemoteContainmentPosture,
} from "./remote/work-remote-host.js";
import {
  DEFAULT_MAX_REMOTE_ARTIFACT_BYTES,
  DEFAULT_REMOTE_CHUNK_BYTES,
  HttpRemoteArtifactTransport,
  REMOTE_ARTIFACT_FEATURE,
   acceptedInputArtifactMap,
  assertArtifactInAcceptedClosure,
  assertExecutionAccessV1,
  assertRemoteOwnerUrl,
  assertStageMetadataForAccess,
  createRemoteArtifactHttpHandler,
  extractExecutionBinding,
  readWorkerCredentialFile,
  remoteStageMetadataSchema,
  sameExecutionBinding,
  verifyByteStream,
  type ExecutionAccessV1,
  type ExecutionBinding,
  type RemoteArtifactClientOptions,
  type RemoteArtifactPortV1,
  type RemoteArtifactServerOptions,
  type RemoteExecutionStage,
  type RemoteStageMetadataV1,
} from "./remote/work-remote-transport.js";
import {
  DEFAULT_MAX_WORKSPACE_FILES,
  DEFAULT_MAX_WORKSPACE_FILE_BYTES,
  DEFAULT_MAX_WORKSPACE_TOTAL_BYTES,
  WORKSPACE_INPUT_BUNDLE_MEDIA_TYPE,
  computeWorkspaceTreeDigest,
  materializeIsolatedWorkspace,
  normalizeWorkspaceFileMode,
  prepareWorkspaceInputBundle,
  readWorkspaceInputBundle,
  scanWorkspaceTree,
  validateWorkspaceRelativePath,
  workspaceFileModeSchema,
  workspaceInputBundleFileSchema,
  workspaceInputBundleSchema,
  workspaceRelativePathSchema,
  workspaceTreeEntrySchema,
  workspaceTreeSnapshotSchema,
  type MaterializedIsolatedWorkspaceV1,
  type ScanWorkspaceTreeOptions,
  type WorkspaceFileMode,
  type WorkspaceInputBundleFileV1,
  type WorkspaceInputBundleV1,
  type WorkspaceTreeEntryV1,
  type WorkspaceTreeSnapshotV1,
} from "./remote/workspace-input.js";
import {
  WorkspaceLockStore,
  verifyCanonicalDirectoryIdentity,
  workspaceLockRecordSchema,
  workspaceLockStateSchema,
  workspaceSettlementProofSchema,
  type AcquireWorkspaceLockInput,
  type WorkspaceLockRecordV1,
  type WorkspaceLockState,
  type WorkspaceSettlementProofV1,
} from "./remote/workspace-lock.js";
import {
  computeWorkspaceMappingDigest,
  prepareWorkspace,
  releaseWorkspace,
  remoteWorkspaceSelectionSchema,
  verifiedWorkspaceSchema,
  verifyForLaunch,
  workspaceMappingEntrySchema,
  type PrepareWorkspaceOptionsV1,
  type RemoteWorkspaceSelectionV1,
  type VerifiedWorkspaceV1,
  type VerifyForLaunchOptionsV1,
  type WorkspaceMappingEntryV1,
  type WorkspaceRuntimeTargetV1,
} from "./remote/workspace-mapping.js";
import {
  WORKSPACE_RESULT_MANIFEST_MEDIA_TYPE,
  applyWorkspaceResultStaged,
  collectWorkspaceResult,
  computeWorkspaceResultManifestDigest,
  verifyWorkspacePublicationConflicts,
  workspaceFileChangeSchema,
  workspaceResultManifestSchema,
  type ApplyWorkspaceResultOptionsV1,
  type CollectWorkspaceResultOptionsV1,
  type VerifyPublicationConflictsOptionsV1,
  type WorkspaceFileChangeV1,
  type WorkspacePublicationConflictV1,
  type WorkspaceResultManifestV1,
} from "./remote/workspace-result.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import type { WorkExecutionStart } from "./work-execution.js";
import { createProcessWorkWorker } from "./work-process-worker.js";
import { ownerCall, WORKER_CREDENTIAL_PREFIX } from "./worker-client.js";

export {
  DEFAULT_MAX_REMOTE_ARTIFACT_BYTES,
  DEFAULT_MAX_WORKSPACE_FILES,
  DEFAULT_MAX_WORKSPACE_FILE_BYTES,
  DEFAULT_MAX_WORKSPACE_TOTAL_BYTES,
  DEFAULT_REMOTE_CHUNK_BYTES,
  HttpRemoteArtifactTransport,
  OwnerStoreArtifactPort,
  REMOTE_ARTIFACT_FEATURE,
  RemoteArtifactCoordinator,
  WORKSPACE_INPUT_BUNDLE_MEDIA_TYPE,
  WORKSPACE_RESULT_MANIFEST_MEDIA_TYPE,
  WorkspaceLockStore,
  acceptedInputArtifactMap,
  applyWorkspaceResultStaged,
  assertArtifactInAcceptedClosure,
  assertExecutionAccessV1,
  assertRemoteOwnerUrl,
  assertStageMetadataForAccess,
  collectWorkspaceResult,
  computeWorkspaceMappingDigest,
  computeWorkspaceResultManifestDigest,
  computeWorkspaceTreeDigest,
  createRemoteArtifactHttpHandler,
  extractExecutionBinding,
  materializeIsolatedWorkspace,
  normalizeWorkspaceFileMode,
  prepareRemoteLaunch,
  prepareWorkspace,
  prepareWorkspaceInputBundle,
  readWorkerCredentialFile,
  readWorkspaceInputBundle,
  recoverRemoteWorkspaceCustody,
  releaseWorkspace,
  remoteStageMetadataSchema,
  remoteWorkspaceSelectionSchema,
  sameExecutionBinding,
  scanWorkspaceTree,
  validateWorkspaceRelativePath,
  verifiedWorkspaceSchema,
  verifyByteStream,
  verifyCanonicalDirectoryIdentity,
  verifyForLaunch,
  verifyWorkspacePublicationConflicts,
  workspaceFileChangeSchema,
  workspaceFileModeSchema,
  workspaceInputBundleFileSchema,
  workspaceInputBundleSchema,
  workspaceLockRecordSchema,
  workspaceLockStateSchema,
  workspaceMappingEntrySchema,
  workspaceRelativePathSchema,
  workspaceResultManifestSchema,
  workspaceSettlementProofSchema,
  workspaceTreeEntrySchema,
  workspaceTreeSnapshotSchema,
  type AcquireWorkspaceLockInput,
  type ApplyWorkspaceResultOptionsV1,
  type CollectWorkspaceResultOptionsV1,
  type DiscardUnlaunchedOptionsV1,
  type ExecutionAccessV1,
  type ExecutionBinding,
  type MaterializedIsolatedWorkspaceV1,
  type OwnerStoreArtifactPortOptions,
  type PrepareRemoteLaunchOptionsV1,
  type PrepareWorkspaceOptionsV1,
  type PreparedRemoteResourcesV1,
  type RemoteArtifactClientOptions,
  type RemoteArtifactCoordinatorOptions,
  type RemoteArtifactPortV1,
  type RemoteArtifactServerOptions,
  type RemoteContainmentPosture,
  type RemoteExecutionStage,
  type RemoteStageMetadataV1,
  type RemoteWorkspaceSelectionV1,
  type ScanWorkspaceTreeOptions,
  type VerifiedWorkspaceV1,
  type VerifyForLaunchOptionsV1,
  type VerifyPublicationConflictsOptionsV1,
  type WorkspaceFileChangeV1,
  type WorkspaceFileMode,
  type WorkspaceInputBundleFileV1,
  type WorkspaceInputBundleV1,
  type WorkspaceLockRecordV1,
  type WorkspaceLockState,
  type WorkspaceMappingEntryV1,
  type WorkspacePublicationConflictV1,
  type WorkspaceResultManifestV1,
  type WorkspaceRuntimeTargetV1,
  type WorkspaceSettlementProofV1,
  type WorkspaceTreeEntryV1,
  type WorkspaceTreeSnapshotV1,
};

const absolute = z.string().max(4096).refine(isAbsolute);
const identifier = z.string().min(1).max(200);

export const processWorkHostRemoteConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    staging_root: absolute,
    isolated_workspace_root: absolute.optional(),
    lock_store_path: absolute.optional(),
    containment_posture: z
      .enum(["portable-pgid", "node-permission-no-child", "linux-cgroup-v2"])
      .default("portable-pgid"),
    workspaces: z.array(workspaceMappingEntrySchema).max(100).default([]),
  })
  .superRefine((remote, ctx) => {
    const refs = new Set<string>();
    const roots = new Set<string>();
    for (const entry of remote.workspaces) {
      if (refs.has(entry.resource_ref)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate remote workspace resource_ref: ${entry.resource_ref}`,
        });
      }
      refs.add(entry.resource_ref);
      if (roots.has(entry.canonical_root)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate remote workspace canonical_root: ${entry.canonical_root}`,
        });
      }
      roots.add(entry.canonical_root);
      if (
        entry.mapping_digest &&
        entry.mapping_digest !== computeWorkspaceMappingDigest(entry)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `Remote workspace ${entry.resource_ref} mapping_digest does not match canonical fields`,
        });
      }
    }
  });
export type ProcessWorkHostRemoteConfig = z.infer<typeof processWorkHostRemoteConfigSchema>;

export const processWorkHostConfigSchema = z
  .strictObject({
    version: z.literal(1),
    installation: identifier,
    directory: absolute,
    artifact_root: absolute,
    owners: z
      .array(
        z.strictObject({
          id: identifier,
          url: z
            .string()
            .max(2048)
            .refine(value => {
              try {
                const url = new URL(value);
                return (
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  !url.hash &&
                  url.pathname === "/" &&
                  (url.protocol === "https:" ||
                    (url.protocol === "http:" &&
                      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
                );
              } catch {
                return false;
              }
            }),
          credential_file: absolute,
        }),
      )
      .min(1)
      .max(16),
    activities: z
      .array(
        z.strictObject({
          type: identifier,
          source: absolute,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          kind: z.enum(["module", "program"]).default("module"),
        }),
      )
      .min(1)
      .max(200),
    max_artifact_bytes: z.number().int().min(1).max(536870912).default(33554432),
    capacity: z.number().int().min(1).max(100).default(4),
    labels: z
      .record(identifier, z.string().max(200))
      .refine(labels => Object.keys(labels).length <= 64)
      .default({}),
    remote: processWorkHostRemoteConfigSchema.optional(),
  })
  .refine(
    value =>
      new Set(value.owners.map(owner => owner.id)).size === value.owners.length &&
      new Set(value.activities.map(activity => activity.type)).size === value.activities.length &&
      (!value.remote ||
        value.remote.workspaces.every(ws => ws.worker_installation === value.installation)),
  );
export type ProcessWorkHostConfig = z.infer<typeof processWorkHostConfigSchema>;

function credential(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    )
      throw new Error("invalid private credential file");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0,
      count: number;
    while (
      length < bytes.length &&
      (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0
    )
      length += count;
    if (length > stat.size) throw new Error("credential file grew");
    const value = bytes.subarray(0, length).toString("utf8").trim();
    if (!value.startsWith(WORKER_CREDENTIAL_PREFIX) || !/^\S+$/.test(value))
      throw new Error("invalid worker credential");
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate and initialize optional remote workspace directories and mappings.
 * Rejects symlinked roots, mismatched device/inode identities, or insecure staging directories.
 */
export function verifyProcessWorkHostRemoteSetup(config: ProcessWorkHostConfig): {
  lockStore: WorkspaceLockStore | null;
} {
  if (!config.remote || !config.remote.enabled) {
    return { lockStore: null };
  }
  mkdirSync(config.remote.staging_root, { recursive: true, mode: 0o700 });
  const stagingIdentity = verifyCanonicalDirectoryIdentity(config.remote.staging_root);
  if ((statSync(stagingIdentity.canonical_root).mode & 0o077) !== 0) {
    throw new WorkflowError(
      "WorkHostConfigurationInvalid",
      "Remote staging_root must be a private 0700 directory.",
      503,
    );
  }

  if (config.remote.isolated_workspace_root) {
    mkdirSync(config.remote.isolated_workspace_root, { recursive: true, mode: 0o700 });
    const isolatedIdentity = verifyCanonicalDirectoryIdentity(
      config.remote.isolated_workspace_root,
    );
    if ((statSync(isolatedIdentity.canonical_root).mode & 0o077) !== 0) {
      throw new WorkflowError(
        "WorkHostConfigurationInvalid",
        "Remote isolated_workspace_root must be a private 0700 directory.",
        503,
      );
    }
  }

  for (const mapping of config.remote.workspaces) {
    const dir = verifyCanonicalDirectoryIdentity(mapping.canonical_root);
    if (dir.dev !== mapping.dev || dir.ino !== mapping.ino) {
      throw new WorkflowError(
        "WorkHostConfigurationInvalid",
        `Configured workspace '${mapping.resource_ref}' device/inode (${dir.dev}:${dir.ino}) does not match (${mapping.dev}:${mapping.ino}).`,
        503,
      );
    }
    if (mapping.expected_base_digest) {
      const snap = scanWorkspaceTree(dir.canonical_root);
      if (snap.tree_digest !== mapping.expected_base_digest) {
        throw new WorkflowError(
          "WorkHostConfigurationInvalid",
          `Configured workspace '${mapping.resource_ref}' base digest ${snap.tree_digest} does not match expected ${mapping.expected_base_digest}.`,
          503,
        );
      }
    }
  }

  const lockStorePath =
    config.remote.lock_store_path ?? join(config.directory, "workspace-locks.sqlite");
  const lockStore = new WorkspaceLockStore({
    path: lockStorePath,
    installation: config.installation,
  });
  return { lockStore };
}

/** Trusted local configuration only. When `remote` is omitted, the artifact root
 * must be shared with each configured owner; when `remote` is configured, remote
 * workspace mappings and artifact transfer ports are validated explicitly. */
export function readProcessWorkHostConfig(path: string): ProcessWorkHostConfig {
  try {
    if (!isAbsolute(path)) throw new Error("absolute configuration path required");
    return processWorkHostConfigSchema.parse(
      JSON.parse(readBoundedFile(path, 131072).toString("utf8")),
    );
  } catch {
    throw new WorkflowError(
      "WorkHostConfigurationInvalid",
      "Process host configuration is unreadable or invalid.",
      503,
    );
  }
}

/** Owns process handles, stage output and delivery independently of an owner/API
 * process. No launch after loss of online authority, and no PID adoption on restart. */
export async function runProcessWorkHost(
  input: ProcessWorkHostConfig,
  options: {
    signal: AbortSignal;
    onReady?: () => void;
    onError?: (error: unknown) => void;
    resolveProcessSecrets?: (start: WorkExecutionStart) => Promise<Record<string, string>>;
    artifactPorts?: Record<string, RemoteArtifactPortV1>;
  },
): Promise<void> {
  let config: ProcessWorkHostConfig,
    clients: { owner: string; client: ReturnType<typeof connectWorkOwnerV3> }[],
    remotePorts: Map<string, RemoteArtifactPortV1>;
  try {
    config = processWorkHostConfigSchema.parse(input);
    clients = config.owners.map(owner => ({
      owner: owner.id,
      client: connectWorkOwnerV3(owner.id, ownerCall(owner.url, credential(owner.credential_file))),
    }));
    remotePorts = new Map(
      config.owners.map(owner => [
        owner.id,
        options.artifactPorts?.[owner.id] ??
          new HttpRemoteArtifactTransport({
            ownerUrl: owner.url,
            credential: () => credential(owner.credential_file),
            maxArtifactBytes: config.max_artifact_bytes,
          }),
      ]),
    );
  } catch {
    throw new WorkflowError(
      "WorkHostConfigurationInvalid",
      "Process host configuration or private worker credentials are invalid.",
      503,
    );
  }
  if (options.signal.aborted) return;

  let lockStore: WorkspaceLockStore | null = null;
  try {
    ({ lockStore } = verifyProcessWorkHostRemoteSetup(config));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(
      "WorkHostConfigurationInvalid",
      "Process host remote workspace configuration is invalid.",
      503,
    );
  }

  const artifacts = new WorkArtifactStore(config.artifact_root, config.max_artifact_bytes);
  try {
    // Pin only explicitly installed code. Loading configuration never imports it.
    for (const activity of config.activities) {
      const bytes = readBoundedFile(
        activity.source,
        activity.kind === "module" ? 2_097_152 : config.max_artifact_bytes,
      );
      if (
        (activity.kind === "module"
          ? inspectArtifact(activity.source, activity.type, "activity", false).digest
          : createHash("sha256").update(bytes).digest("hex")) !== activity.digest
      )
        throw new WorkflowError(
          "WorkHostArtifactUnavailable",
          "Installed process code does not match its pinned digest.",
          409,
        );
      const retained = artifacts.stage(bytes, {
        owner_identity: null,
        purpose: "source",
        media_type: activity.kind === "module" ? "text/javascript" : "application/octet-stream",
      });
      if (retained.digest !== activity.digest)
        throw new WorkflowError(
          "WorkHostArtifactUnavailable",
          "Installed process code changed while being retained.",
          409,
        );
    }
  } finally {
    artifacts.close();
  }

  const registry = new Map(config.activities.map(activity => [activity.type, activity]));
  const clientByOwner = new Map(clients.map(entry => [entry.owner, entry.client]));
  const runtimeArtifacts = new WorkArtifactStore(config.artifact_root, config.max_artifact_bytes);

  const host = createProcessWorkWorker({
    installation: config.installation,
    journalPath: join(config.directory, "work-executor.db"),
    artifactRoot: config.artifact_root,
    connections: clients,
    capacity: config.capacity,
    maxArtifactBytes: config.max_artifact_bytes,
    resolveProcessSecrets:
      options.resolveProcessSecrets ??
      (async start => {
        const program = start.process_program,
          owner = program?.credential_owner;
        if (
          owner?.kind !== "installation" ||
          owner.installation !== config.installation ||
          start.owner !== config.installation
        )
          throw new Error("This host has no selected identity credential resolver.");
        return installationSecrets(program!.secret_names);
      }),
    advertisement: {
      types: [...registry.keys()],
      artifacts: Object.fromEntries(
        [...registry].map(([type, activity]) => [type, activity.digest]),
      ),
      labels: config.labels,
    },
    prepare: async task => {
      if (
        !task.work ||
        registry.get(task.type)?.digest !== task.artifact ||
        task.work.source.digest !== task.artifact ||
        (registry.get(task.type)?.kind === "program") !== Boolean(task.work.process_program)
      )
        throw new WorkflowError(
          "WorkHostArtifactUnavailable",
          "Task does not match installed process code.",
          409,
        );

      if (config.remote?.enabled) {
        const ownerClient = clientByOwner.get(task.owner);
        const port = remotePorts.get(task.owner);
        if (ownerClient?.delegation && port) {
          const delegation = await ownerClient.delegation(task.token);
          const coordinator = new RemoteArtifactCoordinator({
            localArtifacts: runtimeArtifacts,
            port,
            maxArtifactBytes: config.max_artifact_bytes,
          });
          await coordinator.ensureExecutionClosure({
            version: 1,
            delegation,
            connection: ownerClient,
            signal: options.signal,
            workerInstallation: config.installation,
          });
        }
      }
    },
    onError: options.onError,
  });

  if (lockStore) {
    recoverRemoteWorkspaceCustody({
      journal: host.journal,
      lockStore,
    });
  }

  try {
    options.onReady?.();
    while (!options.signal.aborted) {
      await host.worker.tick();
      await delay(100, undefined, { signal: options.signal }).catch(error => {
        if (!options.signal.aborted) throw error;
      });
    }
  } finally {
    await host.close();
    runtimeArtifacts.close();
    lockStore?.close();
  }
}
