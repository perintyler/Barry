import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { WorkflowError } from "../errors.js";
import { readBoundedFile } from "../read-bounded.js";
import type {
  WorkArtifactRef,
  WorkArtifactStore,
} from "../work-artifacts.js";
import { executionBindingSchema, workArtifactSchema } from "../work-contracts.js";
import type { RemoteArtifactCoordinator } from "./work-remote-artifacts.js";
import {
  assertExecutionAccessV1,
  extractExecutionBinding,
  sameExecutionBinding,
  type ExecutionAccessV1,
  type ExecutionBinding,
  type RemoteExecutionStage,
} from "./work-remote-transport.js";
import {
  DEFAULT_MAX_WORKSPACE_FILE_BYTES,
  normalizeWorkspaceFileMode,
  scanWorkspaceTree,
  validateWorkspaceRelativePath,
  workspaceRelativePathSchema,
  type ScanWorkspaceTreeOptions,
  type WorkspaceTreeSnapshotV1,
} from "./workspace-input.js";
import { verifyCanonicalDirectoryIdentity, type WorkspaceLockStore } from "./workspace-lock.js";
import { verifiedWorkspaceSchema, type VerifiedWorkspaceV1 } from "./workspace-mapping.js";

export const WORKSPACE_RESULT_MANIFEST_MEDIA_TYPE =
  "application/vnd.barry.workspace-result-manifest+json" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyRef = z.string().min(1).max(200);

export const workspaceFileChangeSchema = z
  .strictObject({
    path: workspaceRelativePathSchema,
    change_kind: z.enum(["added", "modified", "deleted"]),
    old_digest: sha256Schema.nullable(),
    old_bytes: z.number().int().nonnegative().nullable(),
    old_executable: z.boolean().nullable(),
    new_digest: sha256Schema.nullable(),
    new_bytes: z.number().int().nonnegative().nullable(),
    new_executable: z.boolean().nullable(),
    artifact: workArtifactSchema.nullable(),
  })
  .superRefine((change, ctx) => {
    if (change.change_kind === "added") {
      if (
        change.old_digest !== null ||
        change.old_bytes !== null ||
        change.old_executable !== null ||
        change.new_digest === null ||
        change.new_bytes === null ||
        change.new_executable === null ||
        change.artifact === null
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Added workspace file change must have null old_* fields and non-null new_*/artifact fields.",
        });
      }
    } else if (change.change_kind === "modified") {
      if (
        change.old_digest === null ||
        change.old_bytes === null ||
        change.old_executable === null ||
        change.new_digest === null ||
        change.new_bytes === null ||
        change.new_executable === null ||
        change.artifact === null
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Modified workspace file change must have non-null old_*, new_*, and artifact fields.",
        });
      }
    } else if (change.change_kind === "deleted") {
      if (
        change.old_digest === null ||
        change.old_bytes === null ||
        change.old_executable === null ||
        change.new_digest !== null ||
        change.new_bytes !== null ||
        change.new_executable !== null ||
        change.artifact !== null
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Deleted workspace file change must have non-null old_* fields and null new_*/artifact fields.",
        });
      }
    }
    if (
      change.artifact !== null &&
      (change.artifact.digest !== change.new_digest || change.artifact.bytes !== change.new_bytes)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Workspace file change artifact digest/bytes must match new_digest/new_bytes.",
      });
    }
  });
export type WorkspaceFileChangeV1 = z.infer<typeof workspaceFileChangeSchema>;

export const workspaceResultManifestSchema = z.strictObject({
  version: z.literal(1),
  binding: executionBindingSchema,
  plan_digest: sha256Schema,
  owner_identity: nonEmptyRef.nullable(),
  owner_installation: nonEmptyRef,
  worker_installation: nonEmptyRef,
  mode: z.enum(["none", "verified", "isolated"]),
  writable: z.boolean(),
  resource_ref: nonEmptyRef.nullable(),
  mapping_version: z.number().int().positive().nullable(),
  mapping_digest: sha256Schema.nullable(),
  base_digest: sha256Schema.nullable(),
  result_tree_digest: sha256Schema.nullable(),
  changes: z.array(workspaceFileChangeSchema),
  manifest_digest: sha256Schema,
});
export type WorkspaceResultManifestV1 = z.infer<typeof workspaceResultManifestSchema>;

export function computeWorkspaceResultManifestDigest(
  manifest: Omit<WorkspaceResultManifestV1, "manifest_digest">,
): string {
  return boundFingerprint(manifest);
}

export interface CollectWorkspaceResultOptionsV1 {
  readonly baseSnapshot: WorkspaceTreeSnapshotV1 | null;
  readonly localArtifacts: WorkArtifactStore;
  readonly artifactCoordinator?: RemoteArtifactCoordinator;
  readonly lockStore?: WorkspaceLockStore;
  readonly stage?: RemoteExecutionStage;
  readonly purpose?: Exclude<WorkArtifactRef["purpose"], "source" | "input">;
  readonly scanOptions?: ScanWorkspaceTreeOptions;
  readonly now?: () => number;
}

/**
 * Inspect the post-execution state of a `VerifiedWorkspaceV1`, enforce read-only
 * workspace immutability, stage all added/modified files and the digested
 * `WorkspaceResultManifestV1` into CAS (and optional remote artifact port), and
 * return both the manifest and its `WorkArtifactRef`.
 *
 * Never auto-applies changes to a shared repository.
 */
export async function collectWorkspaceResult(
  access: ExecutionAccessV1,
  rawHandle: VerifiedWorkspaceV1,
  options: CollectWorkspaceResultOptionsV1,
): Promise<{
  readonly manifest: WorkspaceResultManifestV1;
  readonly manifestArtifact: WorkArtifactRef;
  readonly resultSnapshot: WorkspaceTreeSnapshotV1 | null;
}> {
  const handle = verifiedWorkspaceSchema.parse(rawHandle);
  const delegation = await assertExecutionAccessV1(access, {
    ...(options.now ? { now: options.now } : {}),
    workerInstallation: handle.worker_installation,
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

  const stage = options.stage ?? "publication";
  const purpose = options.purpose ?? "output";
  const ownerIdentity =
    delegation.start.output_identity !== undefined
      ? delegation.start.output_identity
      : delegation.namespace.identity_id;

  const stageBytes = async (
    bytes: Buffer,
    mediaType: string,
    isPrimaryManifest: boolean,
  ): Promise<WorkArtifactRef> => {
    const localRef = options.localArtifacts.stage(bytes, {
      purpose,
      owner_identity: ownerIdentity,
      media_type: mediaType,
    });
    options.localArtifacts.retainExecutor(localRef);
    if (options.artifactCoordinator && isPrimaryManifest) {
      await options.artifactCoordinator.stageExecutionArtifact(access, stage, bytes, {
        purpose,
        mediaType,
      });
    }
    return localRef;
  };

  if (handle.mode === "none") {
    const bodyWithoutDigest: Omit<WorkspaceResultManifestV1, "manifest_digest"> = {
      version: 1,
      binding,
      plan_digest: delegation.start.plan_digest,
      owner_identity: ownerIdentity,
      owner_installation: handle.owner_installation,
      worker_installation: handle.worker_installation,
      mode: "none",
      writable: false,
      resource_ref: null,
      mapping_version: null,
      mapping_digest: null,
      base_digest: null,
      result_tree_digest: null,
      changes: [],
    };
    const manifest: WorkspaceResultManifestV1 = workspaceResultManifestSchema.parse({
      ...bodyWithoutDigest,
      manifest_digest: computeWorkspaceResultManifestDigest(bodyWithoutDigest),
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestArtifact = await stageBytes(
      manifestBytes,
      WORKSPACE_RESULT_MANIFEST_MEDIA_TYPE,
      true,
    );
    return {
      manifest,
      manifestArtifact,
      resultSnapshot: null,
    };
  }

  if (
    handle.canonical_root === null ||
    handle.dev === null ||
    handle.ino === null ||
    handle.lock_id === null ||
    handle.base_digest === null ||
    !options.baseSnapshot
  ) {
    throw new WorkflowError(
      "WorkWorkspaceHandleInvalid",
      "Workspace result collection requires canonical_root, lock_id, base_digest, and baseSnapshot.",
      409,
    );
  }
  if (options.baseSnapshot.tree_digest !== handle.base_digest) {
    throw new WorkflowError(
      "WorkWorkspaceDigestMismatch",
      "Provided baseSnapshot digest does not match VerifiedWorkspaceV1.base_digest.",
      409,
    );
  }

  const dirIdentity = verifyCanonicalDirectoryIdentity(handle.canonical_root);
  if (dirIdentity.dev !== handle.dev || dirIdentity.ino !== handle.ino) {
    throw new WorkflowError(
      "WorkWorkspaceChanged",
      "Workspace root directory inode changed during execution.",
      409,
    );
  }

  if (options.lockStore) {
    options.lockStore.assertActiveLock(handle.lock_id, handle.binding);
  }

  const currentSnapshot = scanWorkspaceTree(handle.canonical_root, options.scanOptions);
  const baseByPath = new Map(options.baseSnapshot.files.map(f => [f.path, f]));
  const currentByPath = new Map(currentSnapshot.files.map(f => [f.path, f]));
  const allPaths = [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const maxFileBytes = options.scanOptions?.maxFileBytes ?? DEFAULT_MAX_WORKSPACE_FILE_BYTES;
  const changes: WorkspaceFileChangeV1[] = [];

  for (const relPath of allPaths) {
    const oldEntry = baseByPath.get(relPath);
    const newEntry = currentByPath.get(relPath);

    if (!oldEntry && newEntry) {
      if (!handle.writable) {
        throw new WorkflowError(
          "WorkWorkspaceWriteUnauthorized",
          `Unauthorized file creation '${relPath}' in read-only workspace.`,
          403,
        );
      }
      const absPath = join(handle.canonical_root, relPath);
      const fileBytes = readBoundedFile(absPath, maxFileBytes);
      const actualDigest = createHash("sha256").update(fileBytes).digest("hex");
      if (actualDigest !== newEntry.digest || fileBytes.byteLength !== newEntry.bytes) {
        throw new WorkflowError(
          "WorkWorkspaceChanged",
          `Workspace file '${relPath}' mutated during result collection.`,
          409,
        );
      }
      const fileArtifact = await stageBytes(fileBytes, "application/octet-stream", false);
      changes.push({
        path: relPath,
        change_kind: "added",
        old_digest: null,
        old_bytes: null,
        old_executable: null,
        new_digest: newEntry.digest,
        new_bytes: newEntry.bytes,
        new_executable: newEntry.executable,
        artifact: fileArtifact,
      });
    } else if (oldEntry && !newEntry) {
      if (!handle.writable) {
        throw new WorkflowError(
          "WorkWorkspaceWriteUnauthorized",
          `Unauthorized file deletion '${relPath}' in read-only workspace.`,
          403,
        );
      }
      changes.push({
        path: relPath,
        change_kind: "deleted",
        old_digest: oldEntry.digest,
        old_bytes: oldEntry.bytes,
        old_executable: oldEntry.executable,
        new_digest: null,
        new_bytes: null,
        new_executable: null,
        artifact: null,
      });
    } else if (
      oldEntry &&
      newEntry &&
      (oldEntry.digest !== newEntry.digest ||
        oldEntry.bytes !== newEntry.bytes ||
        oldEntry.executable !== newEntry.executable)
    ) {
      if (!handle.writable) {
        throw new WorkflowError(
          "WorkWorkspaceWriteUnauthorized",
          `Unauthorized file modification '${relPath}' in read-only workspace.`,
          403,
        );
      }
      const absPath = join(handle.canonical_root, relPath);
      const fileBytes = readBoundedFile(absPath, maxFileBytes);
      const actualDigest = createHash("sha256").update(fileBytes).digest("hex");
      if (actualDigest !== newEntry.digest || fileBytes.byteLength !== newEntry.bytes) {
        throw new WorkflowError(
          "WorkWorkspaceChanged",
          `Workspace file '${relPath}' mutated during result collection.`,
          409,
        );
      }
      const fileArtifact = await stageBytes(fileBytes, "application/octet-stream", false);
      changes.push({
        path: relPath,
        change_kind: "modified",
        old_digest: oldEntry.digest,
        old_bytes: oldEntry.bytes,
        old_executable: oldEntry.executable,
        new_digest: newEntry.digest,
        new_bytes: newEntry.bytes,
        new_executable: newEntry.executable,
        artifact: fileArtifact,
      });
    }
  }

  if (!handle.writable && currentSnapshot.tree_digest !== handle.base_digest) {
    throw new WorkflowError(
      "WorkWorkspaceWriteUnauthorized",
      "Read-only workspace tree digest drifted from base_digest.",
      403,
    );
  }

  const bodyWithoutDigest: Omit<WorkspaceResultManifestV1, "manifest_digest"> = {
    version: 1,
    binding,
    plan_digest: delegation.start.plan_digest,
    owner_identity: ownerIdentity,
    owner_installation: handle.owner_installation,
    worker_installation: handle.worker_installation,
    mode: handle.mode,
    writable: handle.writable,
    resource_ref: handle.resource_ref,
    mapping_version: handle.mapping_version,
    mapping_digest: handle.mapping_digest,
    base_digest: handle.base_digest,
    result_tree_digest: currentSnapshot.tree_digest,
    changes,
  };
  const manifest: WorkspaceResultManifestV1 = workspaceResultManifestSchema.parse({
    ...bodyWithoutDigest,
    manifest_digest: computeWorkspaceResultManifestDigest(bodyWithoutDigest),
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestArtifact = await stageBytes(
    manifestBytes,
    WORKSPACE_RESULT_MANIFEST_MEDIA_TYPE,
    true,
  );

  return {
    manifest,
    manifestArtifact,
    resultSnapshot: currentSnapshot,
  };
}

export interface WorkspacePublicationConflictV1 {
  readonly path: string | null;
  readonly reason:
    | "base_digest_mismatch"
    | "unexpected_existing_file"
    | "modified_target_missing"
    | "modified_target_drifted"
    | "deleted_target_missing"
    | "deleted_target_drifted";
  readonly expected_digest: string | null;
  readonly actual_digest: string | null;
}

export interface VerifyPublicationConflictsOptionsV1 {
  readonly expectedResourceRef?: string;
  readonly expectedOwnerIdentity?: string | null;
  readonly expectedBinding?: ExecutionBinding;
  readonly requireExactBaseDigest?: boolean;
  readonly scanOptions?: ScanWorkspaceTreeOptions;
}

/**
 * Pure conflict verification of a `WorkspaceResultManifestV1` against a target
 * directory without mutating any files on disk.
 */
export function verifyWorkspacePublicationConflicts(
  rawManifest: WorkspaceResultManifestV1,
  targetRoot: string,
  options: VerifyPublicationConflictsOptionsV1 = {},
): {
  readonly ok: boolean;
  readonly conflicts: readonly WorkspacePublicationConflictV1[];
  readonly targetSnapshot: WorkspaceTreeSnapshotV1;
} {
  const manifest = workspaceResultManifestSchema.parse(rawManifest);
  const { manifest_digest, ...body } = manifest;
  if (computeWorkspaceResultManifestDigest(body) !== manifest_digest) {
    throw new WorkflowError(
      "WorkWorkspaceManifestInvalid",
      "Workspace result manifest_digest does not match manifest contents.",
      409,
    );
  }
  if (!manifest.writable || manifest.mode === "none") {
    throw new WorkflowError(
      "WorkWorkspaceWriteForbidden",
      "Cannot publish a workspace result manifest from a non-writable or 'none' workspace.",
      403,
    );
  }
  if (
    options.expectedResourceRef !== undefined &&
    manifest.resource_ref !== options.expectedResourceRef
  ) {
    throw new WorkflowError(
      "WorkWorkspaceResourceMismatch",
      `Result manifest resource_ref '${String(manifest.resource_ref)}' does not match target '${options.expectedResourceRef}'.`,
      409,
    );
  }
  if (
    options.expectedOwnerIdentity !== undefined &&
    manifest.owner_identity !== options.expectedOwnerIdentity
  ) {
    throw new WorkflowError(
      "WorkArtifactOwnerMismatch",
      `Result manifest owner_identity '${String(manifest.owner_identity)}' does not match expected '${String(options.expectedOwnerIdentity)}'.`,
      403,
    );
  }
  if (
    options.expectedBinding !== undefined &&
    !sameExecutionBinding(manifest.binding, options.expectedBinding)
  ) {
    throw new WorkflowError(
      "ExecutorBindingConflict",
      "Result manifest binding does not match expected execution binding.",
      409,
    );
  }

  const targetSnapshot = scanWorkspaceTree(targetRoot, options.scanOptions);
  const targetByPath = new Map(targetSnapshot.files.map(f => [f.path, f]));
  const conflicts: WorkspacePublicationConflictV1[] = [];

  if (
    options.requireExactBaseDigest !== false &&
    manifest.base_digest !== null &&
    targetSnapshot.tree_digest !== manifest.base_digest
  ) {
    conflicts.push({
      path: null,
      reason: "base_digest_mismatch",
      expected_digest: manifest.base_digest,
      actual_digest: targetSnapshot.tree_digest,
    });
  }

  for (const change of manifest.changes) {
    validateWorkspaceRelativePath(change.path);
    const current = targetByPath.get(change.path);
    if (change.change_kind === "added") {
      if (current) {
        conflicts.push({
          path: change.path,
          reason: "unexpected_existing_file",
          expected_digest: null,
          actual_digest: current.digest,
        });
      }
    } else if (change.change_kind === "modified") {
      if (!current) {
        conflicts.push({
          path: change.path,
          reason: "modified_target_missing",
          expected_digest: change.old_digest,
          actual_digest: null,
        });
      } else if (
        current.digest !== change.old_digest ||
        current.bytes !== change.old_bytes ||
        current.executable !== change.old_executable
      ) {
        conflicts.push({
          path: change.path,
          reason: "modified_target_drifted",
          expected_digest: change.old_digest,
          actual_digest: current.digest,
        });
      }
    } else if (change.change_kind === "deleted") {
      if (!current) {
        conflicts.push({
          path: change.path,
          reason: "deleted_target_missing",
          expected_digest: change.old_digest,
          actual_digest: null,
        });
      } else if (
        current.digest !== change.old_digest ||
        current.bytes !== change.old_bytes ||
        current.executable !== change.old_executable
      ) {
        conflicts.push({
          path: change.path,
          reason: "deleted_target_drifted",
          expected_digest: change.old_digest,
          actual_digest: current.digest,
        });
      }
    }
  }

  return {
    ok: conflicts.length === 0,
    conflicts,
    targetSnapshot,
  };
}

export interface ApplyWorkspaceResultOptionsV1 extends VerifyPublicationConflictsOptionsV1 {
  readonly targetRoot: string;
  readonly artifacts: WorkArtifactStore;
  readonly authorizedBy: string;
}

/**
 * Explicitly apply a verified `WorkspaceResultManifestV1` to a target workspace directory
 * only after verifying caller authority, zero publication conflicts, and every staged
 * file artifact's cryptographic digest.
 */
export function applyWorkspaceResultStaged(
  rawManifest: WorkspaceResultManifestV1,
  options: ApplyWorkspaceResultOptionsV1,
): WorkspaceTreeSnapshotV1 {
  if (!options.authorizedBy || options.authorizedBy.trim().length === 0) {
    throw new WorkflowError(
      "WorkWorkspacePublishUnauthorized",
      "Applying a workspace result manifest requires an explicit authorizedBy actor/owner.",
      403,
    );
  }
  const manifest = workspaceResultManifestSchema.parse(rawManifest);
  const rootIdentity = verifyCanonicalDirectoryIdentity(options.targetRoot);
  const check = verifyWorkspacePublicationConflicts(manifest, rootIdentity.canonical_root, options);
  if (!check.ok) {
    throw new WorkflowError(
      "WorkWorkspacePublicationConflict",
      `Workspace publication conflict detected (${check.conflicts.map(c => `${c.path ?? "<root>"}:${c.reason}`).join(", ")}).`,
      409,
    );
  }

  // Pre-verify all required artifacts before touching the target tree
  const verifiedPayloads = new Map<string, Buffer>();
  for (const change of manifest.changes) {
    if (change.change_kind === "added" || change.change_kind === "modified") {
      const ref = change.artifact!;
      if (ref.owner_identity !== null && ref.owner_identity !== manifest.owner_identity) {
        throw new WorkflowError(
          "WorkArtifactOwnerMismatch",
          `Change artifact for ${change.path} has mismatched owner_identity.`,
          403,
        );
      }
      const bytes = options.artifacts.verify(ref);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== change.new_digest || bytes.byteLength !== change.new_bytes) {
        throw new WorkflowError(
          "WorkArtifactDigestMismatch",
          `Change artifact for ${change.path} failed digest/bytes verification.`,
          409,
        );
      }
      verifiedPayloads.set(change.path, bytes);
    }
  }

  const stagedTemps: string[] = [];
  try {
    for (const change of manifest.changes) {
      const targetPath = join(rootIdentity.canonical_root, change.path);
      const rel = relative(rootIdentity.canonical_root, targetPath);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        throw new WorkflowError(
          "WorkWorkspacePathTraversal",
          `Publication change path ${change.path} escapes target root.`,
          403,
        );
      }

      if (change.change_kind === "deleted") {
        const st = lstatSync(targetPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new WorkflowError(
            "WorkWorkspaceSymlinkDenied",
            `Cannot delete non-regular or symlink target ${change.path}.`,
            403,
          );
        }
        unlinkSync(targetPath);
        continue;
      }

      const payload = verifiedPayloads.get(change.path)!;
      const parentDir = dirname(targetPath);
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      const parentIdentity = verifyCanonicalDirectoryIdentity(parentDir);
      const relParent = relative(rootIdentity.canonical_root, parentIdentity.canonical_root);
      if (relParent === ".." || relParent.startsWith("../") || isAbsolute(relParent)) {
        throw new WorkflowError(
          "WorkWorkspacePathTraversal",
          `Parent directory for ${change.path} escapes target root.`,
          403,
        );
      }

      const mode = normalizeWorkspaceFileMode(change.new_executable ? 0o700 : 0o600, true);
      const tempPath = join(parentIdentity.canonical_root, `.barry-stage-${randomUUID()}.tmp`);
      stagedTemps.push(tempPath);
      const fd = openSync(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode,
      );
      try {
        let offset = 0;
        while (offset < payload.byteLength) {
          offset += writeSync(fd, payload, offset, payload.byteLength - offset);
        }
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, targetPath);
    }
  } finally {
    for (const tmp of stagedTemps) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* already renamed or cleaned */
      }
    }
  }

  const afterSnapshot = scanWorkspaceTree(rootIdentity.canonical_root, options.scanOptions);
  if (
    manifest.result_tree_digest !== null &&
    afterSnapshot.tree_digest !== manifest.result_tree_digest
  ) {
    throw new WorkflowError(
      "WorkWorkspaceDigestMismatch",
      `Target tree digest after publication (${afterSnapshot.tree_digest}) does not match manifest result_tree_digest (${manifest.result_tree_digest}).`,
      409,
    );
  }
  return afterSnapshot;
}
