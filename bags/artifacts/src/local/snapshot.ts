import type Database from "better-sqlite3";
import Sqlite from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SnapshotResource } from "@barry-rocks/sdk/stores";
import { ArtifactError } from "../types.js";
import type { ArtifactBlob } from "../blobs.js";
import type { LocalArtifactBlobs } from "./blobs.js";
import type { createLocalArtifactMaintenance } from "./maintenance.js";

export async function captureArtifactSnapshot(database: Database.Database, blobs: LocalArtifactBlobs, maintenance: ReturnType<typeof createLocalArtifactMaintenance>, destination: string): Promise<SnapshotResource[]> {
  if (database.inTransaction) throw new ArtifactError("unavailable");
  for (const path of [destination, `${destination}.resources`]) {
    try { await lstat(path); throw new ArtifactError("unavailable"); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const pinId = randomUUID(), resource: SnapshotResource = { name: "blobs", files: [] };
  maintenance.pin(pinId, []);
  let captured: Sqlite.Database | undefined;
  let ownsResources = false;
  try {
    await database.backup(destination);
    blobs.assertCurrent();
    captured = new Sqlite(destination, { fileMustExist: true });
    captured.pragma("journal_mode = DELETE"); captured.pragma("synchronous = FULL");
    captured.exec("DROP TABLE IF EXISTS store_snapshot_files; CREATE TABLE store_snapshot_files(resource TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(resource,path)) STRICT");
    const references = captured.prepare("SELECT sha256,max(size) AS size FROM artifacts GROUP BY sha256 ORDER BY sha256");
    // Artifact content rows cannot be deleted; they protect the snapshot-to-pin interval.
    for (const row of references.iterate() as Iterable<ArtifactBlob>) {
      if (resource.files.length >= 100_000) throw new ArtifactError("too_large");
      resource.files.push({ path: `sha256/${row.sha256.slice(0, 2)}/${row.sha256}`, bytes: row.size, checksum: row.sha256 });
    }
    for (let offset = 0; offset < resource.files.length; offset += 1000) maintenance.pin(pinId, resource.files.slice(offset, offset + 1000).map(file => file.checksum));
    await mkdir(`${destination}.resources`, { mode: 0o700 }); ownsResources = true;
    const root = join(`${destination}.resources`, "blobs"), hashes = join(root, "sha256");
    await mkdir(root, { mode: 0o700 }); await mkdir(hashes, { mode: 0o700 });
    const directories = new Set([`${destination}.resources`, root, hashes]);
    for (const file of resource.files) {
      const blob = { sha256: file.checksum, size: file.bytes };
      await blobs.verify(blob);
      const target = join(root, file.path), bucket = dirname(target);
      if (!directories.has(bucket)) { await mkdir(bucket, { mode: 0o700 }); directories.add(bucket); }
      await copyFile(join(blobs.directory, file.path), target, constants.COPYFILE_EXCL);
      const hash = createHash("sha256"); let bytes = 0;
      const input = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { for await (const chunk of input.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; } } finally { await input.close(); }
      if (bytes !== file.bytes || hash.digest("hex") !== file.checksum) throw new ArtifactError("unavailable");
      await chmod(target, 0o400);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      blobs.assertCurrent();
    }
    captured.transaction(() => {
      const insert = captured!.prepare("INSERT INTO store_snapshot_files VALUES('blobs',?,?,?)");
      for (const file of resource.files) insert.run(file.path, file.bytes, file.checksum);
    })();
    captured.close(); captured = undefined;
    await chmod(destination, 0o400);
    const catalog = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await catalog.sync(); } finally { await catalog.close(); }
    directories.add(dirname(destination));
    for (const path of directories) {
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    maintenance.pin(pinId, []);
    return [resource];
  } catch (error) {
    captured?.close(); captured = undefined;
    await rm(destination, { force: true });
    if (ownsResources) await rm(`${destination}.resources`, { recursive: true, force: true });
    throw error;
  } finally { maintenance.releasePin(pinId); }
}
