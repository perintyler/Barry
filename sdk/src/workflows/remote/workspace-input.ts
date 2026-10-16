import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { WorkflowError } from "../errors.js";
import { readBoundedFile } from "../read-bounded.js";
import type { WorkArtifactRef, WorkArtifactStore } from "../work-artifacts.js";
import { verifyCanonicalDirectoryIdentity } from "./workspace-lock.js";

export const WORKSPACE_INPUT_BUNDLE_MEDIA_TYPE =
  "application/vnd.barry.workspace-input-bundle+json" as const;
export const DEFAULT_MAX_WORKSPACE_FILES = 5_000;
export const DEFAULT_MAX_WORKSPACE_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export function validateWorkspaceRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new WorkflowError(
      "WorkWorkspacePathInvalid",
      `Invalid workspace relative path: ${JSON.stringify(value)}.`,
      400,
    );
  }
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new WorkflowError(
        "WorkWorkspacePathTraversal",
        `Workspace relative path contains forbidden segment: ${JSON.stringify(value)}.`,
        403,
      );
    }
    const lower = part.toLowerCase();
    if (
      /^\.env(?:\.|$)/i.test(part) ||
      lower === ".ssh" ||
      lower === ".barry" ||
      lower === "secrets" ||
      lower === "credentials"
    ) {
      throw new WorkflowError(
        "WorkWorkspacePathForbidden",
        `Workspace relative path references forbidden secret or control path: ${JSON.stringify(value)}.`,
        403,
      );
    }
  }
  return value;
}

export const workspaceRelativePathSchema = z.string().min(1).max(2048).superRefine((val, ctx) => {
  try {
    validateWorkspaceRelativePath(val);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      message: err instanceof Error ? err.message : "Invalid workspace relative path",
    });
  }
});

export const workspaceFileModeSchema = z.union([
  z.literal(0o400),
  z.literal(0o500),
  z.literal(0o600),
  z.literal(0o700),
  z.literal(0o644),
  z.literal(0o755),
]);
export type WorkspaceFileMode = z.infer<typeof workspaceFileModeSchema>;

export function normalizeWorkspaceFileMode(mode: number, writable: boolean): WorkspaceFileMode {
  const executable = (mode & 0o111) !== 0;
  if (writable) {
    return executable ? 0o700 : 0o600;
  }
  return executable ? 0o500 : 0o400;
}

export const workspaceTreeEntrySchema = z.strictObject({
  path: workspaceRelativePathSchema,
  digest: sha256Schema,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
});
export type WorkspaceTreeEntryV1 = z.infer<typeof workspaceTreeEntrySchema>;

export const workspaceTreeSnapshotSchema = z.strictObject({
  version: z.literal(1),
  tree_digest: sha256Schema,
  total_bytes: z.number().int().nonnegative(),
  files: z.array(workspaceTreeEntrySchema),
});
export type WorkspaceTreeSnapshotV1 = z.infer<typeof workspaceTreeSnapshotSchema>;

export const workspaceInputBundleFileSchema = z.strictObject({
  path: workspaceRelativePathSchema,
  digest: sha256Schema,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type WorkspaceInputBundleFileV1 = z.infer<typeof workspaceInputBundleFileSchema>;

export const workspaceInputBundleSchema = z.strictObject({
  version: z.literal(1),
  resource_ref: z.string().min(1).max(200),
  base_digest: sha256Schema,
  total_bytes: z.number().int().nonnegative(),
  files: z.array(workspaceInputBundleFileSchema).max(DEFAULT_MAX_WORKSPACE_FILES),
});
export type WorkspaceInputBundleV1 = z.infer<typeof workspaceInputBundleSchema>;

export function computeWorkspaceTreeDigest(entries: readonly WorkspaceTreeEntryV1[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return boundFingerprint({
    version: 1,
    files: sorted.map(item => ({
      path: item.path,
      digest: item.digest,
      bytes: item.bytes,
      executable: item.executable,
    })),
  });
}

function assertNoPathConflicts(paths: readonly string[]): void {
  const exactSet = new Set<string>();
  const caseFoldSet = new Set<string>();
  for (const path of paths) {
    validateWorkspaceRelativePath(path);
    if (exactSet.has(path)) {
      throw new WorkflowError(
        "WorkWorkspaceManifestInvalid",
        `Duplicate workspace file path: ${path}.`,
        409,
      );
    }
    const lower = path.toLowerCase();
    if (caseFoldSet.has(lower)) {
      throw new WorkflowError(
        "WorkWorkspaceManifestInvalid",
        `Case-colliding workspace file path: ${path}.`,
        409,
      );
    }
    exactSet.add(path);
    caseFoldSet.add(lower);
  }
  for (const path of paths) {
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
      if (exactSet.has(parent) || caseFoldSet.has(parent.toLowerCase())) {
        throw new WorkflowError(
          "WorkWorkspaceManifestInvalid",
          `Workspace file/directory path conflict between ${path} and ${parent}.`,
          409,
        );
      }
    }
  }
}

export interface ScanWorkspaceTreeOptions {
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  readonly allowHardlinks?: boolean;
}

/**
 * Recursively scan a canonical directory tree without following symlinks,
 * rejecting any symlink, special file, hardlink (`nlink > 1` unless explicitly allowed),
 * forbidden path, or oversized file/tree.
 */
export function scanWorkspaceTree(
  rootPath: string,
  options: ScanWorkspaceTreeOptions = {},
): WorkspaceTreeSnapshotV1 {
  const rootInfo = verifyCanonicalDirectoryIdentity(rootPath);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_WORKSPACE_FILE_BYTES;
  const allowHardlinks = options.allowHardlinks ?? false;

  const entries: WorkspaceTreeEntryV1[] = [];
  let totalBytes = 0;

  const visit = (currentDir: string, relPrefix: string) => {
    const dirStat = lstatSync(currentDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new WorkflowError(
        "WorkWorkspaceSymlinkDenied",
        `Workspace directory component ${currentDir} is a symlink or non-directory.`,
        403,
      );
    }
    if (realpathSync(currentDir) !== currentDir) {
      throw new WorkflowError(
        "WorkWorkspaceSymlinkDenied",
        `Workspace directory ${currentDir} resolved outside canonical tree.`,
        403,
      );
    }

    const dirEntries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

    for (const dirent of dirEntries) {
      if (dirent.name === ".git") {
        // Skip internal .git metadata directory during workspace scan ONLY if it is a real directory
        //Wait: what if someone puts a symlink at .git? Check lstat first!
      }
      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const absPath = join(currentDir, dirent.name);
      const itemLstat = lstatSync(absPath);
      if (itemLstat.isSymbolicLink()) {
        throw new WorkflowError(
          "WorkWorkspaceSymlinkDenied",
          `Workspace contains symbolic link at ${relPath}.`,
          403,
        );
      }
      validateWorkspaceRelativePath(relPath);
      const insideRel = relative(rootInfo.canonical_root, absPath);
      if (insideRel === ".." || insideRel.startsWith("../") || isAbsolute(insideRel)) {
        throw new WorkflowError(
          "WorkWorkspacePathTraversal",
          `Workspace entry ${relPath} escapes root ${rootInfo.canonical_root}.`,
          403,
        );
      }

      if (itemLstat.isDirectory()) {
        visit(absPath, relPath);
        continue;
      }
      if (!itemLstat.isFile()) {
        throw new WorkflowError(
          "WorkWorkspaceUnsupportedFileType",
          `Workspace entry ${relPath} is not a regular file or directory.`,
          409,
        );
      }
      if (!allowHardlinks && itemLstat.nlink > 1) {
        throw new WorkflowError(
          "WorkWorkspaceHardlinkDenied",
          `Workspace file ${relPath} has hardlink count ${itemLstat.nlink} > 1.`,
          403,
        );
      }
      if (entries.length + 1 > maxFiles) {
        throw new WorkflowError(
          "WorkWorkspaceLimitExceeded",
          `Workspace exceeds maximum file count (${maxFiles}).`,
          413,
        );
      }
      if (itemLstat.size > maxFileBytes) {
        throw new WorkflowError(
          "WorkWorkspaceLimitExceeded",
          `Workspace file ${relPath} (${itemLstat.size} bytes) exceeds maxFileBytes (${maxFileBytes}).`,
          413,
        );
      }

      const fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let fileBytes: Buffer;
      try {
        const openedStat = fstatSync(fd);
        if (
          !openedStat.isFile() ||
          openedStat.dev !== itemLstat.dev ||
          openedStat.ino !== itemLstat.ino ||
          (!allowHardlinks && openedStat.nlink > 1)
        ) {
          throw new WorkflowError(
            "WorkWorkspaceChanged",
            `Workspace file ${relPath} changed during verification.`,
            409,
          );
        }
        fileBytes = readBoundedFile(absPath, maxFileBytes);
        const afterStat = fstatSync(fd);
        if (
          fileBytes.byteLength !== openedStat.size ||
          afterStat.size !== openedStat.size ||
          afterStat.mtimeMs !== openedStat.mtimeMs ||
          afterStat.ctimeMs !== openedStat.ctimeMs
        ) {
          throw new WorkflowError(
            "WorkWorkspaceChanged",
            `Workspace file ${relPath} was modified concurrently during scan.`,
            409,
          );
        }
      } finally {
        closeSync(fd);
      }

      totalBytes += fileBytes.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new WorkflowError(
          "WorkWorkspaceLimitExceeded",
          `Workspace total size (${totalBytes} bytes) exceeds maxTotalBytes (${maxTotalBytes}).`,
          413,
        );
      }
      const digest = createHash("sha256").update(fileBytes).digest("hex");
      entries.push({
        path: relPath,
        digest,
        bytes: fileBytes.byteLength,
        executable: (itemLstat.mode & 0o111) !== 0,
      });
    }
  };

  visit(rootInfo.canonical_root, "");
  assertNoPathConflicts(entries.map(e => e.path));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tree_digest = computeWorkspaceTreeDigest(entries);
  return {
    version: 1,
    tree_digest,
    total_bytes: totalBytes,
    files: entries,
  };
}

/**
 * Stage a verified `WorkspaceInputBundleV1` into an owner `WorkArtifactStore` from
 * an explicit list of `{ path, content, executable? }` or a source directory.
 */
export function prepareWorkspaceInputBundle(options: {
  readonly artifacts: WorkArtifactStore;
  readonly resource_ref: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: Buffer | Uint8Array | string;
    readonly executable?: boolean;
  }[];
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
}): {
  readonly artifact: WorkArtifactRef;
  readonly bundle: WorkspaceInputBundleV1;
  readonly snapshot: WorkspaceTreeSnapshotV1;
} {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_WORKSPACE_FILE_BYTES;

  if (options.files.length > maxFiles) {
    throw new WorkflowError(
      "WorkWorkspaceLimitExceeded",
      `Workspace input bundle file count ${options.files.length} exceeds ${maxFiles}.`,
      413,
    );
  }
  assertNoPathConflicts(options.files.map(f => f.path));

  let totalBytes = 0;
  const bundleFiles: WorkspaceInputBundleFileV1[] = [];
  const treeEntries: WorkspaceTreeEntryV1[] = [];

  const sortedInputs = [...options.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const item of sortedInputs) {
    const cleanPath = validateWorkspaceRelativePath(item.path);
    const bytes =
      typeof item.content === "string"
        ? Buffer.from(item.content, "utf8")
        : Buffer.isBuffer(item.content)
          ? item.content
          : Buffer.from(item.content);
    if (bytes.byteLength > maxFileBytes) {
      throw new WorkflowError(
        "WorkWorkspaceLimitExceeded",
        `Workspace input file ${cleanPath} (${bytes.byteLength} bytes) exceeds limit ${maxFileBytes}.`,
        413,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new WorkflowError(
        "WorkWorkspaceLimitExceeded",
        `Workspace input bundle total size ${totalBytes} exceeds limit ${maxTotalBytes}.`,
        413,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const executable = Boolean(item.executable);
    bundleFiles.push({
      path: cleanPath,
      digest,
      bytes: bytes.byteLength,
      executable,
      data: bytes.toString("base64"),
    });
    treeEntries.push({
      path: cleanPath,
      digest,
      bytes: bytes.byteLength,
      executable,
    });
  }

  const base_digest = computeWorkspaceTreeDigest(treeEntries);
  const bundle = workspaceInputBundleSchema.parse({
    version: 1,
    resource_ref: options.resource_ref,
    base_digest,
    total_bytes: totalBytes,
    files: bundleFiles,
  });

  const payload = Buffer.from(JSON.stringify(bundle), "utf8");
  const artifact = options.artifacts.stage(payload, {
    purpose: "source",
    owner_identity: null,
    media_type: WORKSPACE_INPUT_BUNDLE_MEDIA_TYPE,
  });

  return {
    artifact,
    bundle,
    snapshot: {
      version: 1,
      tree_digest: base_digest,
      total_bytes: totalBytes,
      files: treeEntries,
    },
  };
}

/**
 * Parse and cryptographically verify every file entry and the overall `base_digest`
 * of a `WorkspaceInputBundleV1` byte payload.
 */
export function readWorkspaceInputBundle(
  bytes: Buffer | Uint8Array,
  options: {
    readonly maxFiles?: number;
    readonly maxTotalBytes?: number;
    readonly maxFileBytes?: number;
    readonly expectedResourceRef?: string;
    readonly expectedBaseDigest?: string;
  } = {},
): {
  readonly bundle: WorkspaceInputBundleV1;
  readonly decodedFiles: readonly {
    readonly path: string;
    readonly digest: string;
    readonly bytes: number;
    readonly executable: boolean;
    readonly content: Buffer;
  }[];
  readonly snapshot: WorkspaceTreeSnapshotV1;
} {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_WORKSPACE_FILE_BYTES;

  let rawJson: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rawJson = JSON.parse(text);
  } catch {
    throw new WorkflowError(
      "WorkWorkspaceManifestInvalid",
      "Workspace input bundle is not valid UTF-8 JSON.",
      409,
    );
  }

  const parsed = workspaceInputBundleSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new WorkflowError(
      "WorkWorkspaceManifestInvalid",
      `Workspace input bundle failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid bundle"}.`,
      409,
    );
  }
  const bundle = parsed.data;
  if (bundle.files.length > maxFiles) {
    throw new WorkflowError(
      "WorkWorkspaceLimitExceeded",
      `Workspace input bundle file count ${bundle.files.length} exceeds ${maxFiles}.`,
      413,
    );
  }
  if (options.expectedResourceRef && bundle.resource_ref !== options.expectedResourceRef) {
    throw new WorkflowError(
      "WorkWorkspaceResourceMismatch",
      `Workspace input bundle resource_ref ${bundle.resource_ref} does not match expected ${options.expectedResourceRef}.`,
      409,
    );
  }

  assertNoPathConflicts(bundle.files.map(f => f.path));

  let totalBytes = 0;
  const decodedFiles: {
    path: string;
    digest: string;
    bytes: number;
    executable: boolean;
    content: Buffer;
  }[] = [];
  const treeEntries: WorkspaceTreeEntryV1[] = [];

  for (const item of bundle.files) {
    const content = Buffer.from(item.data, "base64");
    if (content.toString("base64") !== item.data) {
      throw new WorkflowError(
        "WorkWorkspaceManifestInvalid",
        `Workspace input file ${item.path} has non-canonical base64 data.`,
        409,
      );
    }
    if (content.byteLength !== item.bytes) {
      throw new WorkflowError(
        "WorkWorkspaceManifestInvalid",
        `Workspace input file ${item.path} byte count ${content.byteLength} differs from declared ${item.bytes}.`,
        409,
      );
    }
    if (content.byteLength > maxFileBytes) {
      throw new WorkflowError(
        "WorkWorkspaceLimitExceeded",
        `Workspace input file ${item.path} (${content.byteLength} bytes) exceeds maxFileBytes (${maxFileBytes}).`,
        413,
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new WorkflowError(
        "WorkWorkspaceLimitExceeded",
        `Workspace input bundle total size ${totalBytes} exceeds maxTotalBytes (${maxTotalBytes}).`,
        413,
      );
    }
    const actualDigest = createHash("sha256").update(content).digest("hex");
    if (actualDigest !== item.digest) {
      throw new WorkflowError(
        "WorkWorkspaceDigestMismatch",
        `Workspace input file ${item.path} digest ${actualDigest} does not match declared ${item.digest}.`,
        409,
      );
    }
    decodedFiles.push({
      path: item.path,
      digest: item.digest,
      bytes: item.bytes,
      executable: item.executable,
      content,
    });
    treeEntries.push({
      path: item.path,
      digest: item.digest,
      bytes: item.bytes,
      executable: item.executable,
    });
  }

  if (totalBytes !== bundle.total_bytes) {
    throw new WorkflowError(
      "WorkWorkspaceManifestInvalid",
      `Workspace input bundle total_bytes ${bundle.total_bytes} does not match sum of file sizes ${totalBytes}.`,
      409,
    );
  }

  const computedBaseDigest = computeWorkspaceTreeDigest(treeEntries);
  if (computedBaseDigest !== bundle.base_digest) {
    throw new WorkflowError(
      "WorkWorkspaceDigestMismatch",
      `Workspace input bundle base_digest ${bundle.base_digest} does not match computed tree digest ${computedBaseDigest}.`,
      409,
    );
  }
  if (options.expectedBaseDigest && bundle.base_digest !== options.expectedBaseDigest) {
    throw new WorkflowError(
      "WorkWorkspaceDigestMismatch",
      `Workspace input bundle base_digest ${bundle.base_digest} does not match expected ${options.expectedBaseDigest}.`,
      409,
    );
  }

  return {
    bundle,
    decodedFiles,
    snapshot: {
      version: 1,
      tree_digest: computedBaseDigest,
      total_bytes: totalBytes,
      files: treeEntries,
    },
  };
}

export interface MaterializedIsolatedWorkspaceV1 {
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
  readonly base_digest: string;
  readonly snapshot: WorkspaceTreeSnapshotV1;
}

/**
 * Materialize a verified `WorkspaceInputBundleV1` into a newly created private `0o700`
 * directory inside `isolatedParentRoot`. Uses `O_CREAT | O_EXCL | O_NOFOLLOW` for every file,
 * verifies the materialized tree snapshot after write, and removes the temporary directory
 * on any failure before returning.
 */
export function materializeIsolatedWorkspace(options: {
  readonly isolatedParentRoot: string;
  readonly bundleBytes: Buffer | Uint8Array;
  readonly writable: boolean;
  readonly expectedResourceRef?: string;
  readonly expectedBaseDigest?: string;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
}): MaterializedIsolatedWorkspaceV1 {
  const parentInfo = verifyCanonicalDirectoryIdentity(options.isolatedParentRoot);
  const parentStat = statSync(parentInfo.canonical_root);
  if ((parentStat.mode & 0o077) !== 0) {
    throw new WorkflowError(
      "WorkWorkspaceDirectoryInsecure",
      `Isolated workspace parent root ${parentInfo.canonical_root} must have 0700 permissions.`,
      403,
    );
  }

  const verified = readWorkspaceInputBundle(options.bundleBytes, {
    ...(options.expectedResourceRef ? { expectedResourceRef: options.expectedResourceRef } : {}),
    ...(options.expectedBaseDigest ? { expectedBaseDigest: options.expectedBaseDigest } : {}),
    ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxTotalBytes ? { maxTotalBytes: options.maxTotalBytes } : {}),
    ...(options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
  });

  const targetDir = join(parentInfo.canonical_root, `isolated-${randomUUID()}`);
  mkdirSync(targetDir, { recursive: false, mode: 0o700 });

  try {
    const dirIdentity = verifyCanonicalDirectoryIdentity(targetDir);
    for (const file of verified.decodedFiles) {
      const targetPath = join(dirIdentity.canonical_root, file.path);
      const rel = relative(dirIdentity.canonical_root, targetPath);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        throw new WorkflowError(
          "WorkWorkspacePathTraversal",
          `Isolated workspace file ${file.path} escapes workspace root.`,
          403,
        );
      }
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      const parentCheck = verifyCanonicalDirectoryIdentity(dirname(targetPath));
      const relParent = relative(dirIdentity.canonical_root, parentCheck.canonical_root);
      if (relParent === ".." || relParent.startsWith("../") || isAbsolute(relParent)) {
        throw new WorkflowError(
          "WorkWorkspacePathTraversal",
          `Isolated workspace parent directory for ${file.path} escapes root.`,
          403,
        );
      }

      const fileMode = normalizeWorkspaceFileMode(file.executable ? 0o700 : 0o600, options.writable);
      const fd = openSync(
        targetPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        fileMode,
      );
      try {
        let offset = 0;
        while (offset < file.content.byteLength) {
          offset += writeSync(fd, file.content, offset, file.content.byteLength - offset);
        }
        fchmodSync(fd, fileMode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    const postScan = scanWorkspaceTree(dirIdentity.canonical_root, {
      ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
      ...(options.maxTotalBytes ? { maxTotalBytes: options.maxTotalBytes } : {}),
      ...(options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
    });
    if (postScan.tree_digest !== verified.bundle.base_digest) {
      throw new WorkflowError(
        "WorkWorkspaceDigestMismatch",
        "Materialized isolated workspace tree digest does not match verified input bundle base_digest.",
        409,
      );
    }

    return {
      canonical_root: dirIdentity.canonical_root,
      dev: dirIdentity.dev,
      ino: dirIdentity.ino,
      base_digest: postScan.tree_digest,
      snapshot: postScan,
    };
  } catch (error) {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* preserve original materialization error */
    }
    throw error;
  }
}
