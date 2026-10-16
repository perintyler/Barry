import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { workArtifactSchema } from "./work-contracts.js";
import { WorkflowError } from "./errors.js";
import type { z } from "zod";
export type WorkArtifactRef = z.infer<typeof workArtifactSchema>;

/** Private owner-local content store. Public fetchers must recheck authority before reading. */
export interface StagedArtifactCandidate {
  namespace_hash: string;
  file: string;
  path: string;
  identity: string;
  modified_at: number;
}
export class WorkArtifactStore {
  private scan?: Generator<StagedArtifactCandidate>;
  readonly root: string;
  constructor(
    root: string,
    readonly maxArtifactBytes = 33_554_432,
  ) {
    if (!isAbsolute(root)) throw new Error("work artifact root must be absolute");
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1)
      throw new Error("invalid artifact byte limit");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  /** Executor spool ownership is durable and independent of owner staging GC.
   * Pins deliberately survive acknowledgements; evidence archival must explicitly
   * retire the executor spool before reclaiming these bytes. */
  retainExecutor(reference: WorkArtifactRef): void {
    this.verify(reference);
    const namespace = createHash("sha256").update(JSON.stringify(reference.owner_identity)).digest("hex");
    const spool = join(this.root, ".executor-retained"), directory = join(spool, namespace);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(spool) !== spool || realpathSync(directory) !== directory)
      throw new Error("unsafe executor spool path");
    const target = join(directory, reference.digest);
    try { linkSync(this.path(reference), target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pin = lstatSync(target), source = lstatSync(this.path(reference));
      if (!pin.isFile() || pin.dev !== source.dev || pin.ino !== source.ino)
        throw new Error("executor spool pin differs from retained artifact");
    }
    for (const path of [directory, spool, this.root]) {
      const descriptor = openSync(path, constants.O_RDONLY);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  }
  executorRetained(namespace: string, digest: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(namespace) || !/^[a-f0-9]{64}$/.test(digest)) return false;
    return existsSync(join(this.root, ".executor-retained", namespace, digest));
  }
  claimOwner(owner: string): void {
    if (Buffer.byteLength(owner) > 200 || !owner) throw new Error("invalid artifact owner");
    const marker = join(this.root, ".owner");
    try {
      writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    }
    const descriptor = openSync(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(descriptor),
        bytes = Buffer.alloc(201);
      if (
        !stat.isFile() ||
        stat.size > 200 ||
        bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString() !== owner
      )
        throw new WorkflowError(
          "ArtifactOwnerMismatch",
          "Artifact storage belongs to another owner.",
          409,
        );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const directory = openSync(this.root, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private *candidates(): Generator<StagedArtifactCandidate> {
    const namespaces = opendirSync(this.root);
    try {
      let namespace;
      while ((namespace = namespaces.readSync())) {
        if (!namespace.isDirectory() || !/^[a-f0-9]{64}$/.test(namespace.name)) continue;
        const directory = join(this.root, namespace.name);
        if (realpathSync(directory) !== directory) continue;
        const files = opendirSync(directory);
        try {
          let entry;
          while ((entry = files.readSync())) {
            if (!entry.isFile() || !/^(?:[a-f0-9]{64}|\.stage-[a-f0-9-]{36})$/.test(entry.name))
              continue;
            const path = join(directory, entry.name);
            let stat;
            try {
              stat = lstatSync(path);
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
                continue;
              throw error;
            }
            if (!stat.isFile()) continue;
            yield {
              namespace_hash: namespace.name,
              file: entry.name,
              path,
              identity: `${stat.dev}:${stat.ino}`,
              modified_at: stat.mtimeMs,
            };
          }
        } finally {
          files.closeSync();
        }
      }
    } finally {
      namespaces.closeSync();
    }
  }
  /** Bounded incremental scan; open directory handles are closed at owner shutdown. */
  scanStaging(limit = 64): StagedArtifactCandidate[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new Error("invalid staging scan budget");
    this.scan ??= this.candidates();
    const candidates: StagedArtifactCandidate[] = [];
    for (let index = 0; index < limit; index++) {
      const next = this.scan.next();
      if (next.done) {
        this.scan = undefined;
        break;
      }
      candidates.push(next.value);
    }
    return candidates;
  }
  candidate(namespace: string, file: string): StagedArtifactCandidate | null {
    if (!/^[a-f0-9]{64}$/.test(namespace) || !/^(?:[a-f0-9]{64}|\.stage-[a-f0-9-]{36})$/.test(file))
      throw new Error("unsafe staging cleanup reference");
    const directory = join(this.root, namespace);
    if (!existsSync(directory)) return null;
    if (realpathSync(directory) !== directory) throw new Error("unsafe staging namespace");
    const path = join(directory, file);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("staging cleanup refuses symlinks and non-files");
    return {
      namespace_hash: namespace,
      file,
      path,
      identity: `${stat.dev}:${stat.ino}`,
      modified_at: stat.mtimeMs,
    };
  }
  close(): void {
    this.scan?.return(undefined);
    this.scan = undefined;
  }
  private directory(identity: string | null): string {
    const namespace = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const directory = join(this.root, namespace);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    if (realpathSync(directory) !== directory)
      throw new WorkflowError(
        "ArtifactPathUnsafe",
        "Artifact namespace must not be a symlink.",
        409,
      );
    return directory;
  }
  path(reference: WorkArtifactRef): string {
    const artifact = workArtifactSchema.parse(reference);
    const directory = this.directory(artifact.owner_identity), path = join(directory, artifact.digest);
    const retained = join(this.root, ".executor-retained", directory.slice(this.root.length + 1), artifact.digest);
    // A concurrent owner unlink cannot destroy the executor-owned inode. Restore
    // the public CAS name on lookup, without rereading or repeating any effect.
    if (!existsSync(path) && existsSync(retained)) {
      const spoolDirectory = join(this.root, ".executor-retained", directory.slice(this.root.length + 1));
      if (realpathSync(join(this.root, ".executor-retained")) !== join(this.root, ".executor-retained") ||
        realpathSync(spoolDirectory) !== spoolDirectory || !lstatSync(retained).isFile())
        throw new Error("unsafe executor spool artifact");
      try { linkSync(retained, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    return path;
  }
  stage(
    bytes: Buffer,
    metadata: Pick<WorkArtifactRef, "owner_identity" | "purpose" | "media_type">,
  ): WorkArtifactRef {
    if (bytes.length > this.maxArtifactBytes)
      throw new WorkflowError(
        "ArtifactTooLarge",
        "Artifact exceeds its configured byte limit.",
        413,
      );
    const reference = workArtifactSchema.parse({
      ...metadata,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    const target = this.path(reference);
    if (existsSync(target)) {
      this.verify(reference);
      return reference;
    }
    const temporary = join(this.directory(reference.owner_identity), `.stage-${randomUUID()}`);
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, target);
      const directory = openSync(this.directory(reference.owner_identity), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.verify(reference);
      return reference;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  verify(reference: WorkArtifactRef): Buffer {
    const artifact = workArtifactSchema.parse(reference);
    if (artifact.bytes > this.maxArtifactBytes)
      throw new WorkflowError(
        "ArtifactTooLarge",
        "Artifact exceeds its configured byte limit.",
        413,
      );
    const descriptor = openSync(
      this.path(artifact),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size !== artifact.bytes)
        throw new WorkflowError(
          "ArtifactMismatch",
          "Retained artifact size differs from its accepted reference.",
          409,
        );
      const bounded = Buffer.alloc(artifact.bytes + 1);
      let offset = 0,
        count: number;
      while (
        offset < bounded.length &&
        (count = readSync(descriptor, bounded, offset, bounded.length - offset, null)) > 0
      )
        offset += count;
      const bytes = bounded.subarray(0, offset);
      if (
        bytes.length !== artifact.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.digest
      )
        throw new WorkflowError(
          "ArtifactMismatch",
          "Retained artifact digest differs from its accepted reference.",
          409,
        );
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }
}
