import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { WorkflowError } from "../errors.js";
import { executionBindingSchema, workArtifactSchema } from "../work-contracts.js";
import type { RemoteArtifactCoordinator } from "./work-remote-artifacts.js";
import {
  assertExecutionAccessV1,
  extractExecutionBinding,
  sameExecutionBinding,
  type ExecutionAccessV1,
} from "./work-remote-transport.js";
import {
  materializeIsolatedWorkspace,
  scanWorkspaceTree,
  type ScanWorkspaceTreeOptions,
  type WorkspaceTreeSnapshotV1,
} from "./workspace-input.js";
import {
  verifyCanonicalDirectoryIdentity,
  type WorkspaceLockRecordV1,
  type WorkspaceLockStore,
  type WorkspaceSettlementProofV1,
} from "./workspace-lock.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyRef = z.string().min(1).max(200);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(val => isAbsolute(val) && !val.includes("\0"));

export const workspaceMappingEntrySchema = z.strictObject({
  version: z.literal(1),
  resource_ref: nonEmptyRef,
  mapping_version: z.number().int().positive(),
  worker_installation: nonEmptyRef,
  canonical_root: absolutePathSchema,
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  writable_allowed: z.boolean(),
  expected_base_digest: sha256Schema.optional(),
  mapping_digest: sha256Schema.optional(),
});
export type WorkspaceMappingEntryV1 = z.infer<typeof workspaceMappingEntrySchema>;

export function computeWorkspaceMappingDigest(
  entry: Omit<WorkspaceMappingEntryV1, "mapping_digest" | "expected_base_digest">,
): string {
  return boundFingerprint({
    version: 1,
    resource_ref: entry.resource_ref,
    mapping_version: entry.mapping_version,
    worker_installation: entry.worker_installation,
    canonical_root: entry.canonical_root,
    dev: entry.dev,
    ino: entry.ino,
    writable_allowed: entry.writable_allowed,
  });
}

export const remoteWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("none"),
    requires_filesystem: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("host-bound"),
    installation: nonEmptyRef,
    path: absolutePathSchema,
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
    writable: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("verified"),
    resource_ref: nonEmptyRef,
    mapping_version: z.number().int().positive(),
    mapping_digest: sha256Schema,
    expected_base_digest: sha256Schema.optional(),
    writable: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("isolated"),
    resource_ref: nonEmptyRef,
    input_bundle: workArtifactSchema.refine(val => val.purpose === "source"),
    expected_base_digest: sha256Schema,
    writable: z.boolean(),
    exclusive_resource: z.boolean().optional(),
  }),
]);
export type RemoteWorkspaceSelectionV1 = z.infer<typeof remoteWorkspaceSelectionSchema>;

export const verifiedWorkspaceSchema = z.strictObject({
  version: z.literal(1),
  binding: executionBindingSchema,
  resource_ref: nonEmptyRef.nullable(),
  mapping_version: z.number().int().positive().nullable(),
  mapping_digest: sha256Schema.nullable(),
  owner_installation: nonEmptyRef,
  worker_installation: nonEmptyRef,
  canonical_root: absolutePathSchema.nullable(),
  dev: z.number().int().nonnegative().nullable(),
  ino: z.number().int().nonnegative().nullable(),
  lock_id: z.uuid().nullable(),
  mode: z.enum(["none", "verified", "isolated"]),
  writable: z.boolean(),
  base_digest: sha256Schema.nullable(),
});
export type VerifiedWorkspaceV1 = z.infer<typeof verifiedWorkspaceSchema>;

export interface WorkspaceRuntimeTargetV1 {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface PrepareWorkspaceOptionsV1 {
  readonly workerInstallation: string;
  readonly mappings?: readonly WorkspaceMappingEntryV1[];
  readonly isolatedParentRoot?: string;
  readonly lockStore?: WorkspaceLockStore;
  readonly artifactCoordinator?: RemoteArtifactCoordinator;
  readonly scanOptions?: ScanWorkspaceTreeOptions;
  readonly now?: () => number;
}

export interface VerifyForLaunchOptionsV1 {
  readonly workerInstallation: string;
  readonly mappings?: readonly WorkspaceMappingEntryV1[];
  readonly lockStore?: WorkspaceLockStore;
  readonly requiredRuntimes?: readonly WorkspaceRuntimeTargetV1[];
  readonly verifyCleanBaseDigest?: boolean;
  readonly scanOptions?: ScanWorkspaceTreeOptions;
  readonly now?: () => number;
}

/**
 * Resolve, verify, and lock a remote workspace according to `RemoteWorkspaceSelectionV1`.
 *
 * Enforces:
 * - Explicit refusal of `host-bound` workspaces on remote workers (never rewrites a local
 *   path to a remote path).
 * - `none` mode refuses tasks declaring `requires_filesystem: true` and returns a null-rooted
 *   read-only handle.
 * - `verified` mode checks the worker's configured mapping table for `resource_ref`,
 *   verifies `mapping_version`, `mapping_digest`, canonical directory path (no symlinks),
 *   `dev`/`ino` stability, write permission policy, tree snapshot digest (`base_digest`),
 *   and acquires a durable writer lock in `WorkspaceLockStore`.
 * - `isolated` mode downloads/verifies `input_bundle` via `RemoteArtifactCoordinator`,
 *   materializes it into a fresh private `0o700` directory under `isolatedParentRoot`,
 *   verifies `expected_base_digest`, and acquires a durable custody lock in `WorkspaceLockStore`.
 */
export async function prepareWorkspace(
  access: ExecutionAccessV1,
  rawSelection: RemoteWorkspaceSelectionV1,
  options: PrepareWorkspaceOptionsV1,
): Promise<{
  readonly workspace: VerifiedWorkspaceV1;
  readonly baseSnapshot: WorkspaceTreeSnapshotV1 | null;
}> {
  const delegation = await assertExecutionAccessV1(access, {
    ...(options.now ? { now: options.now } : {}),
    workerInstallation: options.workerInstallation,
    requireOnlineAuthority: true,
  });
  const selection = remoteWorkspaceSelectionSchema.parse(rawSelection);
  const binding = extractExecutionBinding(delegation);
  const ownerInstallation = delegation.start.owner;
  const workerInstallation = options.workerInstallation;

  if (selection.kind === "host-bound") {
    throw new WorkflowError(
      "WorkHostBoundRemoteRefused",
      `Host-bound workspace (${selection.path} on ${selection.installation}) cannot execute on remote worker ${workerInstallation}; use 'none', 'verified', or 'isolated'.`,
      409,
    );
  }

  if (selection.kind === "none") {
    if (selection.requires_filesystem) {
      throw new WorkflowError(
        "WorkWorkspaceModeUnsupported",
        "Workspace mode 'none' cannot execute a task that requires filesystem access.",
        409,
      );
    }
    return {
      workspace: verifiedWorkspaceSchema.parse({
        version: 1,
        binding,
        resource_ref: null,
        mapping_version: null,
        mapping_digest: null,
        owner_installation: ownerInstallation,
        worker_installation: workerInstallation,
        canonical_root: null,
        dev: null,
        ino: null,
        lock_id: null,
        mode: "none",
        writable: false,
        base_digest: null,
      }),
      baseSnapshot: null,
    };
  }

  if (selection.kind === "verified") {
    const candidates = (options.mappings ?? []).filter(
      m => m.resource_ref === selection.resource_ref,
    );
    if (candidates.length === 0) {
      throw new WorkflowError(
        "WorkWorkspaceMappingMissing",
        `No verified workspace mapping registered for resource_ref '${selection.resource_ref}' on worker ${workerInstallation}.`,
        409,
      );
    }
    if (candidates.length > 1) {
      throw new WorkflowError(
        "WorkWorkspaceMappingAmbiguous",
        `Ambiguous workspace mappings registered for resource_ref '${selection.resource_ref}'.`,
        409,
      );
    }
    const entry = workspaceMappingEntrySchema.parse(candidates[0]!);
    if (entry.worker_installation !== workerInstallation) {
      throw new WorkflowError(
        "WorkInstallationMismatch",
        `Workspace mapping '${entry.resource_ref}' belongs to installation ${entry.worker_installation}, not ${workerInstallation}.`,
        403,
      );
    }
    if (entry.mapping_version !== selection.mapping_version) {
      throw new WorkflowError(
        "WorkWorkspaceMappingStale",
        `Workspace mapping '${entry.resource_ref}' version ${entry.mapping_version} does not match requested version ${selection.mapping_version}.`,
        409,
      );
    }
    const computedMappingDigest = computeWorkspaceMappingDigest(entry);
    if (
      (entry.mapping_digest && entry.mapping_digest !== computedMappingDigest) ||
      selection.mapping_digest !== computedMappingDigest
    ) {
      throw new WorkflowError(
        "WorkWorkspaceMappingDigestMismatch",
        `Workspace mapping '${entry.resource_ref}' digest does not match requested ${selection.mapping_digest}.`,
        409,
      );
    }
    if (selection.writable && !entry.writable_allowed) {
      throw new WorkflowError(
        "WorkWorkspaceWriteForbidden",
        `Workspace mapping '${entry.resource_ref}' is read-only and does not permit writable execution.`,
        403,
      );
    }

    const dirIdentity = verifyCanonicalDirectoryIdentity(entry.canonical_root);
    if (dirIdentity.dev !== entry.dev || dirIdentity.ino !== entry.ino) {
      throw new WorkflowError(
        "WorkWorkspaceChanged",
        `Verified workspace '${entry.resource_ref}' directory device/inode (${dirIdentity.dev}:${dirIdentity.ino}) differs from mapped (${entry.dev}:${entry.ino}).`,
        409,
      );
    }

    if (!options.lockStore) {
      throw new WorkflowError(
        "WorkWorkspaceLockStoreRequired",
        "Verified workspaces require a durable WorkspaceLockStore.",
        500,
      );
    }

    const lockRecord = options.lockStore.acquire({
      resource_ref: entry.resource_ref,
      mapping_version: entry.mapping_version,
      mapping_digest: computedMappingDigest,
      canonical_root: dirIdentity.canonical_root,
      dev: dirIdentity.dev,
      ino: dirIdentity.ino,
      binding,
    });

    const snapshot = scanWorkspaceTree(dirIdentity.canonical_root, options.scanOptions);
    if (entry.expected_base_digest && snapshot.tree_digest !== entry.expected_base_digest) {
      throw new WorkflowError(
        "WorkWorkspaceDigestMismatch",
        `Verified workspace '${entry.resource_ref}' tree digest ${snapshot.tree_digest} differs from configured ${entry.expected_base_digest}.`,
        409,
      );
    }
    if (
      selection.expected_base_digest &&
      snapshot.tree_digest !== selection.expected_base_digest
    ) {
      throw new WorkflowError(
        "WorkWorkspaceDigestMismatch",
        `Verified workspace '${entry.resource_ref}' tree digest ${snapshot.tree_digest} differs from requested ${selection.expected_base_digest}.`,
        409,
      );
    }

    return {
      workspace: verifiedWorkspaceSchema.parse({
        version: 1,
        binding,
        resource_ref: entry.resource_ref,
        mapping_version: entry.mapping_version,
        mapping_digest: computedMappingDigest,
        owner_installation: ownerInstallation,
        worker_installation: workerInstallation,
        canonical_root: dirIdentity.canonical_root,
        dev: dirIdentity.dev,
        ino: dirIdentity.ino,
        lock_id: lockRecord.lock_id,
        mode: "verified",
        writable: selection.writable,
        base_digest: snapshot.tree_digest,
      }),
      baseSnapshot: snapshot,
    };
  }

  // isolated mode
  if (!options.isolatedParentRoot) {
    throw new WorkflowError(
      "WorkWorkspaceConfigurationMissing",
      "Isolated workspaces require an isolatedParentRoot directory.",
      500,
    );
  }
  if (!options.artifactCoordinator) {
    throw new WorkflowError(
      "WorkWorkspaceConfigurationMissing",
      "Isolated workspaces require a RemoteArtifactCoordinator to fetch input_bundle.",
      500,
    );
  }
  if (!options.lockStore) {
    throw new WorkflowError(
      "WorkWorkspaceLockStoreRequired",
      "Isolated workspaces require a durable WorkspaceLockStore.",
      500,
    );
  }

  options.artifactCoordinator.allowSupplementalArtifact(selection.input_bundle);
  const bundleBytes = await options.artifactCoordinator.ensureLocalArtifact(
    access,
    selection.input_bundle,
  );

  const materialized = materializeIsolatedWorkspace({
    isolatedParentRoot: options.isolatedParentRoot,
    bundleBytes,
    writable: selection.writable,
    expectedResourceRef: selection.resource_ref,
    expectedBaseDigest: selection.expected_base_digest,
    ...(options.scanOptions?.maxFiles ? { maxFiles: options.scanOptions.maxFiles } : {}),
    ...(options.scanOptions?.maxTotalBytes
      ? { maxTotalBytes: options.scanOptions.maxTotalBytes }
      : {}),
    ...(options.scanOptions?.maxFileBytes
      ? { maxFileBytes: options.scanOptions.maxFileBytes }
      : {}),
  });

  const lockResourceRef = selection.exclusive_resource
    ? selection.resource_ref
    : `${selection.resource_ref}#isolated:${binding.attempt_id}`;
  const isolatedMappingDigest = boundFingerprint({
    version: 1,
    mode: "isolated",
    resource_ref: selection.resource_ref,
    input_bundle_digest: selection.input_bundle.digest,
    base_digest: materialized.base_digest,
  });

  const lockRecord = options.lockStore.acquire({
    resource_ref: lockResourceRef,
    mapping_version: 1,
    mapping_digest: isolatedMappingDigest,
    canonical_root: materialized.canonical_root,
    dev: materialized.dev,
    ino: materialized.ino,
    binding,
  });

  return {
    workspace: verifiedWorkspaceSchema.parse({
      version: 1,
      binding,
      resource_ref: selection.resource_ref,
      mapping_version: 1,
      mapping_digest: isolatedMappingDigest,
      owner_installation: ownerInstallation,
      worker_installation: workerInstallation,
      canonical_root: materialized.canonical_root,
      dev: materialized.dev,
      ino: materialized.ino,
      lock_id: lockRecord.lock_id,
      mode: "isolated",
      writable: selection.writable,
      base_digest: materialized.base_digest,
    }),
    baseSnapshot: materialized.snapshot,
  };
}

/**
 * Re-verify online execution authority, workspace root identity (`realpathSync`, `dev`, `ino`),
 * mapping version/digest, active writer lock ownership, absence of symlink escapes, and
 * required runtime executables immediately before main's native launch boundary.
 */
export async function verifyForLaunch(
  access: ExecutionAccessV1,
  rawHandle: VerifiedWorkspaceV1,
  options: VerifyForLaunchOptionsV1,
): Promise<VerifiedWorkspaceV1> {
  const handle = verifiedWorkspaceSchema.parse(rawHandle);
  const delegation = await assertExecutionAccessV1(access, {
    ...(options.now ? { now: options.now } : {}),
    workerInstallation: options.workerInstallation,
    expectedBinding: handle.binding,
    requireOnlineAuthority: true,
  });
  const binding = extractExecutionBinding(delegation);
  if (!sameExecutionBinding(binding, handle.binding)) {
    throw new WorkflowError(
      "ExecutorBindingConflict",
      "Workspace handle binding does not match execution access delegation.",
      409,
    );
  }
  if (handle.worker_installation !== options.workerInstallation) {
    throw new WorkflowError(
      "WorkInstallationMismatch",
      `Workspace handle installation ${handle.worker_installation} does not match ${options.workerInstallation}.`,
      403,
    );
  }

  // Verify any required runtime targets before launch
  for (const rt of options.requiredRuntimes ?? []) {
    if (!isAbsolute(rt.path) || rt.path.includes("\0")) {
      throw new WorkflowError("WorkRuntimeUnavailable", `Invalid runtime path ${rt.path}.`, 409);
    }
    let canonicalRt: string;
    try {
      canonicalRt = realpathSync(rt.path);
    } catch {
      throw new WorkflowError(
        "WorkRuntimeUnavailable",
        `Required runtime ${rt.path} is missing on worker.`,
        409,
      );
    }
    if (canonicalRt !== rt.path) {
      throw new WorkflowError(
        "WorkRuntimeChanged",
        `Required runtime ${rt.path} traverses a symlink (${canonicalRt}).`,
        409,
      );
    }
    const stat = statSync(canonicalRt);
    if (!stat.isFile() || stat.size !== rt.bytes) {
      throw new WorkflowError(
        "WorkRuntimeChanged",
        `Required runtime ${rt.path} byte size (${stat.size}) does not match accepted (${rt.bytes}).`,
        409,
      );
    }
  }

  if (handle.mode === "none") {
    if (
      handle.canonical_root !== null ||
      handle.dev !== null ||
      handle.ino !== null ||
      handle.lock_id !== null ||
      handle.writable
    ) {
      throw new WorkflowError(
        "WorkWorkspaceHandleInvalid",
        "Mode 'none' workspace handle must not carry filesystem root or writer lock.",
        409,
      );
    }
    return handle;
  }

  if (
    handle.canonical_root === null ||
    handle.dev === null ||
    handle.ino === null ||
    handle.lock_id === null ||
    handle.resource_ref === null ||
    handle.mapping_version === null ||
    handle.mapping_digest === null ||
    handle.base_digest === null
  ) {
    throw new WorkflowError(
      "WorkWorkspaceHandleInvalid",
      `Workspace handle in mode '${handle.mode}' is missing required root or lock fields.`,
      409,
    );
  }

  const dirIdentity = verifyCanonicalDirectoryIdentity(handle.canonical_root);
  if (dirIdentity.dev !== handle.dev || dirIdentity.ino !== handle.ino) {
    throw new WorkflowError(
      "WorkWorkspaceChanged",
      `Workspace root ${handle.canonical_root} inode changed before launch.`,
      409,
    );
  }

  if (!options.lockStore) {
    throw new WorkflowError(
      "WorkWorkspaceLockStoreRequired",
      "verifyForLaunch requires WorkspaceLockStore for verified and isolated workspaces.",
      500,
    );
  }
  const activeLock = options.lockStore.assertActiveLock(handle.lock_id, handle.binding);
  if (
    activeLock.canonical_root !== handle.canonical_root ||
    activeLock.dev !== handle.dev ||
    activeLock.ino !== handle.ino ||
    activeLock.mapping_version !== handle.mapping_version ||
    activeLock.mapping_digest !== handle.mapping_digest
  ) {
    throw new WorkflowError(
      "WorkWorkspaceLockBindingMismatch",
      "Active workspace lock metadata does not match VerifiedWorkspaceV1 handle.",
      409,
    );
  }

  if (handle.mode === "verified" && options.mappings) {
    const entry = options.mappings.find(m => m.resource_ref === handle.resource_ref);
    if (!entry) {
      throw new WorkflowError(
        "WorkWorkspaceMappingMissing",
        `Workspace mapping '${handle.resource_ref}' was removed before launch.`,
        409,
      );
    }
    if (
      entry.mapping_version !== handle.mapping_version ||
      computeWorkspaceMappingDigest(entry) !== handle.mapping_digest ||
      entry.canonical_root !== handle.canonical_root ||
      entry.dev !== handle.dev ||
      entry.ino !== handle.ino ||
      (handle.writable && !entry.writable_allowed)
    ) {
      throw new WorkflowError(
        "WorkWorkspaceMappingStale",
        `Workspace mapping '${handle.resource_ref}' changed before launch.`,
        409,
      );
    }
  }

  const currentSnapshot = scanWorkspaceTree(handle.canonical_root, options.scanOptions);
  if (options.verifyCleanBaseDigest !== false && currentSnapshot.tree_digest !== handle.base_digest) {
    throw new WorkflowError(
      "WorkWorkspaceChanged",
      `Workspace tree digest (${currentSnapshot.tree_digest}) drifted from base_digest (${handle.base_digest}) before launch.`,
      409,
    );
  }

  return handle;
}

/**
 * Release a workspace lock only when presented with positive bound `not-started`
 * or `ceased` physical settlement proof.
 */
export function releaseWorkspace(
  rawHandle: VerifiedWorkspaceV1,
  settlement: WorkspaceSettlementProofV1,
  lockStore: WorkspaceLockStore,
): WorkspaceLockRecordV1 | null {
  const handle = verifiedWorkspaceSchema.parse(rawHandle);
  if (handle.mode === "none" || handle.lock_id === null) {
    return null;
  }
  if (settlement.lock_id !== handle.lock_id || !sameExecutionBinding(settlement.binding, handle.binding)) {
    throw new WorkflowError(
      "WorkWorkspaceSettlementMismatch",
      "Workspace settlement proof does not match the VerifiedWorkspaceV1 handle.",
      409,
    );
  }
  return lockStore.release(settlement);
}
