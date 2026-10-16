import Database from "better-sqlite3";
import { mkdir, chmod, lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { StoreBinding } from "@barry-rocks/sdk/stores";
import { ArtifactError, IdentityIdSchema } from "../types.js";
import { createSqliteArtifactRepository } from "./index-store.js";
import { createLocalArtifactBlobs } from "./blobs.js";
import { createLocalArtifactMaintenance } from "./maintenance.js";
import { captureArtifactSnapshot } from "./snapshot.js";
import { randomUUID } from "node:crypto";
import { requireArtifactActivationComplete } from "./activation-journal.js";

export async function openLocalArtifactStore(binding: StoreBinding, options: { existingOnly?: boolean } = {}) {
  if (binding.bag !== "artifacts" || binding.store !== "default" || binding.owned_by !== "identity" || binding.engine !== "sqlite" || !binding.identity)
    throw new ArtifactError("forbidden");
  const identityId = IdentityIdSchema.parse(binding.identity);
  if (!binding.filepath || !isAbsolute(binding.filepath)) throw new ArtifactError("unavailable");
  const filepath = binding.filepath;
  requireArtifactActivationComplete(filepath);
  await mkdir(dirname(filepath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(filepath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new ArtifactError("unavailable");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  const database = new Database(filepath, { fileMustExist: options.existingOnly ?? false });
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_generation_status'").get()
      && (database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined)?.state === "sealed") throw new ArtifactError("unavailable");
    const repository = createSqliteArtifactRepository(database, identityId);
    await chmod(filepath, 0o600);
    const blobs = await createLocalArtifactBlobs(filepath);
    const maintenance = createLocalArtifactMaintenance({ database, identityId, blobs, now: () => new Date().toISOString(), newId: randomUUID });
    let closed = false;
    return Object.freeze({
      binding: Object.freeze({ ...binding }), repository, blobs, maintenance,
      snapshot: (destination: string) => captureArtifactSnapshot(database, blobs, maintenance, destination),
      close() { if (!closed) { database.close(); closed = true; } },
    });
  } catch (error) { database.close(); throw error; }
}
export type LocalArtifactStore = Awaited<ReturnType<typeof openLocalArtifactStore>>;

export async function openReadOnlyArtifactStore(binding: StoreBinding) {
  if (binding.bag !== "artifacts" || binding.store !== "default" || binding.owned_by !== "identity" || binding.engine !== "sqlite" || !binding.identity)
    throw new ArtifactError("forbidden");
  const identityId = IdentityIdSchema.parse(binding.identity);
  if (!binding.filepath || !isAbsolute(binding.filepath)) throw new ArtifactError("unavailable");
  const filepath = binding.filepath;
  requireArtifactActivationComplete(filepath);
  try {
    const existing = await lstat(filepath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new ArtifactError("unavailable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactError("not_found");
    throw error;
  }
  const database = new Database(filepath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    const repository = createSqliteArtifactRepository(database, identityId, { readonly: true });
    const blobs = await createLocalArtifactBlobs(filepath, { readonly: true });
    let closed = false;
    return Object.freeze({ identityId, repository, blobs,
      close() { if (!closed) { database.close(); closed = true; } },
    });
  } catch (error) { database.close(); throw error; }
}
