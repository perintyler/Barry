import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, unlinkSync, fsyncSync, lstatSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ArtifactError, ArtifactIdSchema, ArtifactContentSchema } from "../types.js";
import { MAX_ARTIFACT_BYTES, type ArtifactBlob, type ArtifactBlobStore } from "../blobs.js";
import { requireArtifactActivationComplete } from "./activation-journal.js";
import { verifyArtifactBlobDescriptor } from "./blob-file.js";

const hashSchema = ArtifactContentSchema.unwrap().shape.sha256;
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function requireActiveCatalog(databasePath: string): void {
  requireArtifactActivationComplete(databasePath);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
  try {
    database.pragma("query_only = ON");
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_generation_status'").get()
      && (database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined)?.state !== "active") throw new ArtifactError("unavailable");
  } finally { database.close(); }
}
async function requireDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError("unavailable");
}
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  await requireDirectory(path);
  await chmod(path, 0o700);
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function verifyFile(file: FileHandle, blob: ArtifactBlob, signal?: AbortSignal): Promise<void> {
  const before = await file.stat();
  if (!before.isFile() || before.size !== blob.size || before.size > MAX_ARTIFACT_BYTES) throw new ArtifactError("unavailable");
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < blob.size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, blob.size - position), position);
    if (!bytesRead) throw new ArtifactError("unavailable");
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  const after = await file.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest("hex") !== blob.sha256) throw new ArtifactError("unavailable");
  signal?.throwIfAborted();
}
function nextChunk(iterator: AsyncIterator<Uint8Array>, signal?: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  signal?.throwIfAborted();
  if (!signal) return iterator.next();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason instanceof Error ? signal.reason : new ArtifactError("unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); }).then(
      chunk => { signal.removeEventListener("abort", abort); resolve(chunk); },
      error => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new Error("Artifact operation failed", { cause: error })); },
    );
    if (signal.aborted) abort();
  });
}
export interface LocalArtifactBlobs extends ArtifactBlobStore {
  readonly directory: string;
  assertCurrent(): void;
  verify(blob: ArtifactBlob, signal?: AbortSignal): Promise<void>;
  discardSync(intentId: string): void;
  removeSync(blob: ArtifactBlob): boolean;
  verifySync(blob: ArtifactBlob): void;
}
export async function createLocalArtifactBlobs(databasePath: string, options: { readonly?: boolean } = {}): Promise<LocalArtifactBlobs> {
  if (!isAbsolute(databasePath)) throw new ArtifactError("unavailable");
  requireArtifactActivationComplete(databasePath);
  const database = await lstat(databasePath);
  if (!database.isFile() || database.isSymbolicLink()) throw new ArtifactError("unavailable");
  requireActiveCatalog(databasePath);
  const directory = `${databasePath}.blobs`, staging = join(directory, "staging"), hashes = join(directory, "sha256");
  if (options.readonly) {
    try { await requireDirectory(directory); await requireDirectory(staging); await requireDirectory(hashes); }
    catch { throw new ArtifactError("unavailable"); }
  } else {
    await privateDirectory(directory); await privateDirectory(staging); await privateDirectory(hashes);
    await syncDirectory(directory); await syncDirectory(dirname(databasePath));
  }
  const originalDirectory = await lstat(directory);
  const assertCurrent = () => {
    requireArtifactActivationComplete(databasePath);
    const currentDatabase = lstatSync(databasePath), currentDirectory = lstatSync(directory);
    if (!currentDatabase.isFile() || currentDatabase.isSymbolicLink() || currentDatabase.ino !== database.ino || currentDatabase.dev !== database.dev
      || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.ino !== originalDirectory.ino || currentDirectory.dev !== originalDirectory.dev) throw new ArtifactError("unavailable");
    requireActiveCatalog(databasePath);
  };
  const stagePath = (id: string) => join(staging, ArtifactIdSchema.parse(id));
  const blobPath = (blob: ArtifactBlob) => {
    hashSchema.parse(blob.sha256);
    if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too_large");
    return join(hashes, blob.sha256.slice(0, 2), blob.sha256);
  };
  const requireDirectorySync = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError("unavailable");
  };
  const syncDirectorySync = (path: string) => {
    const file = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(file); } finally { closeSync(file); }
  };
  assertCurrent();
  return {
    directory, assertCurrent,
    verifySync(blob) {
      assertCurrent();
      const path = blobPath(blob);
      requireDirectorySync(directory); requireDirectorySync(hashes); requireDirectorySync(join(hashes, blob.sha256.slice(0, 2)));
      const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { verifyArtifactBlobDescriptor(file, blob, path); } finally { closeSync(file); }
    },
    discardSync(intentId) {
      assertCurrent();
      requireDirectorySync(directory); requireDirectorySync(staging);
      try { unlinkSync(stagePath(intentId)); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      syncDirectorySync(staging);
    },
    removeSync(blob) {
      assertCurrent();
      const path = blobPath(blob), bucket = join(hashes, blob.sha256.slice(0, 2));
      requireDirectorySync(directory); requireDirectorySync(hashes);
      try { requireDirectorySync(bucket); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; syncDirectorySync(hashes); return false; }
      let file: number;
      try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; syncDirectorySync(bucket); return false; }
      try {
        verifyArtifactBlobDescriptor(file, blob, path);
        unlinkSync(path); syncDirectorySync(bucket);
        return true;
      } finally { closeSync(file); }
    },
    async stage(intentId, source, signal) {
      assertCurrent();
      signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
      signal.throwIfAborted();
      const iterator = source[Symbol.asyncIterator]();
      await requireDirectory(directory); await requireDirectory(staging);
      signal.throwIfAborted();
      const path = stagePath(intentId), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      let size = 0, finished = false;
      try {
        for (;;) {
          const chunk = await nextChunk(iterator, signal); signal?.throwIfAborted();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw new ArtifactError("unavailable");
          if (!chunk.value.byteLength) { await setImmediate(); signal.throwIfAborted(); continue; }
          size += chunk.value.byteLength;
          if (size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too_large");
          // Snapshot a producer-owned buffer before awaiting filesystem writes.
          const bytes = Buffer.from(chunk.value); hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            signal?.throwIfAborted();
            const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new ArtifactError("unavailable");
            offset += bytesWritten;
          }
        }
        await file.sync(); await file.chmod(0o400); await file.sync();
        await syncDirectory(staging); assertCurrent(); signal?.throwIfAborted(); finished = true;
        return Object.freeze({ sha256: hash.digest("hex"), size });
      } finally {
        await file.close();
        if (!finished) {
          // Cancellation must finish even when the producer's next/return never settles.
          void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
          assertCurrent();
          await unlink(path).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
        }
      }
    },
    async publish(intentId, blob, signal) {
      assertCurrent();
      signal?.throwIfAborted();
      const destination = blobPath(blob), source = stagePath(intentId);
      await requireDirectory(directory); await requireDirectory(staging); await requireDirectory(hashes);
      await privateDirectory(join(hashes, blob.sha256.slice(0, 2)));
      const staged = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await verifyFile(staged, blob, signal); } finally { await staged.close(); }
      try { await link(source, destination); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      const published = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await verifyFile(published, blob, signal); await published.sync(); }
      finally { await published.close(); }
      await syncDirectory(join(hashes, blob.sha256.slice(0, 2))); await syncDirectory(hashes); await syncDirectory(directory);
      assertCurrent();
      signal?.throwIfAborted();
    },
    async discard(intentId) {
      assertCurrent();
      await requireDirectory(directory); await requireDirectory(staging);
      await unlink(stagePath(intentId)).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
      await syncDirectory(staging);
    },
    async verify(blob, signal) {
      assertCurrent();
      const path = blobPath(blob);
      await requireDirectory(directory); await requireDirectory(hashes); await requireDirectory(join(hashes, blob.sha256.slice(0, 2)));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await verifyFile(file, blob, signal); } finally { await file.close(); }
    },
    async stream(blob, signal) {
      assertCurrent();
      const path = blobPath(blob);
      await requireDirectory(directory); await requireDirectory(hashes); await requireDirectory(join(hashes, blob.sha256.slice(0, 2)));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await verifyFile(file, blob, signal);
        const nodeStream = file.createReadStream({ autoClose: true });
        const hash = createHash("sha256");
        let bytesRead = 0;
        const close = async () => {
          nodeStream.destroy();
          await file.close();
        };
        async function* generator() {
          try {
            for await (const chunk of nodeStream) {
              signal?.throwIfAborted();
              assertCurrent();
              const buffer = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
              bytesRead += buffer.length;
              if (bytesRead > blob.size) throw new ArtifactError("unavailable");
              hash.update(buffer);
              yield buffer;
            }
            if (bytesRead !== blob.size || hash.digest("hex") !== blob.sha256) throw new ArtifactError("unavailable");
          } finally {
            await close();
          }
        }
        const iterator = generator();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => iterator.next(),
              async return() {
                // An unstarted generator does not run its finally block.
                await close();
                return iterator.return();
              },
              async throw(error: unknown) {
                await close();
                return iterator.throw(error);
              },
            };
          },
        };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
  };
}
