import { z } from "zod";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { barryBackupsDir } from "../services/home.mjs";
import {
  SnapshotManifestSchema,
  validateSnapshot,
  copySnapshot,
  type StoreSnapshot,
  type SnapshotManifest,
} from "./registry.js";
export interface BackupManifest {
  format: 1;
  id: string;
  createdAt: string;
  stores: {
    file: string;
    manifest: SnapshotManifest;
  }[];
  deliveries?: Record<
    string,
    {
      status: "complete" | "failed";
      error?: string;
    }
  >;
}
export const BackupManifestSchema = z.strictObject({
  format: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.iso.datetime(),
  stores: z
    .array(
      z.strictObject({ file: z.string().regex(/^\d+\.db$/), manifest: SnapshotManifestSchema }),
    )
    .max(100_000),
  deliveries: z
    .record(
      z.string(),
      z.strictObject({ status: z.enum(["complete", "failed"]), error: z.string().optional() }),
    )
    .optional(),
});
async function syncBackupDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function saveBackupManifest(directory: string, manifest: BackupManifest): Promise<void> {
  const temporary = join(directory, `.manifest-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(manifest));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(directory, "manifest.json"));
  await syncBackupDirectory(directory);
}
export async function createBackup(
  snapshots: StoreSnapshot[],
  options: {
    root?: string;
    retainDays?: number;
    /**
     * Rename each snapshot (and its resources) into the backup instead of
     * copying it. For snapshots taken on the same filesystem only for this
     * backup: it halves the disk a whole-installation backup needs at its peak.
     */
    move?: boolean;
  } = {},
): Promise<BackupManifest> {
  const root = options.root ?? barryBackupsDir();
  const id = randomUUID();
  const temporary = join(root, `.staging-${id}`);
  const directory = join(root, id);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const manifest: BackupManifest = {
    format: 1,
    id,
    createdAt: new Date().toISOString(),
    stores: [],
    deliveries: {},
  };
  try {
    for (const snapshot of snapshots) {
      if (snapshot.manifest.bag === "vault") throw new Error("vault backup is separate");
      await validateSnapshot(snapshot);
      const file = `${manifest.stores.length}.db`;
      if (options.move) {
        await rename(snapshot.path, join(temporary, file));
        if (snapshot.manifest.resources?.length)
          await rename(`${snapshot.path}.resources`, join(temporary, `${file}.resources`));
        await validateSnapshot({ path: join(temporary, file), manifest: snapshot.manifest });
      } else await copySnapshot(snapshot, join(temporary, file));
      manifest.stores.push({ file, manifest: snapshot.manifest });
    }
    await saveBackupManifest(temporary, manifest);
    await rename(temporary, directory);
    await syncBackupDirectory(root);
    await pruneBackups(root, options.retainDays ?? 7);
    return manifest;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
export async function pruneBackups(root: string, retainDays = 7): Promise<void> {
  const cutoff = Date.now() - retainDays * 86400000;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const old = BackupManifestSchema.parse(
        JSON.parse(await readFile(join(root, entry.name, "manifest.json"), "utf8")),
      );
      if (Date.parse(old.createdAt) < cutoff) await rm(join(root, entry.name), { recursive: true });
    } catch {
      /* Unknown directories are never treated as disposable backups. */
    }
  }
}
