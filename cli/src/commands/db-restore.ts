import { pruneOlderGenerations } from "./db-prune.js";
import { constants, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SqliteDatabase as DatabaseSync } from "@barry-rocks/sdk/internal/stores";
import { randomUUID } from "node:crypto";
import { barryAppSupportDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { activateStoreGeneration, bootstrapStoreGeneration, BackupManifestSchema, prepareBackupGeneration, storeKey, validateBackup, validatePreparedStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { readInstallationId } from "@barry-rocks/sdk/internal/nodes";
import { switchStoreGeneration, type StoreServices } from "./db-services.js";
import { pauseRestoredRuns } from "@barry-rocks/sdk/internal/workflows";
import { snapshotStores, managedStoreRegistry, MANAGED_STORES_DIR, sqliteIntegrity, UNMANAGED_STORES_DIR, backedUpDataStores } from "./db-stores.js";

export interface DbRestoreOptions {
  replaceInstallation?: boolean;
  services?: StoreServices;
}

const generationIdentifier = /^[a-z0-9][a-z0-9._-]*$/i;

/** The single registry backup inside a `barry db backup` directory. */
function managedBackupDirectory(directory: string): string {
  const root = join(directory, MANAGED_STORES_DIR);
  if (!existsSync(root)) {
    throw new Error(`${directory} has no ${MANAGED_STORES_DIR}/ folder: it was taken before backups covered every store, or from an install on the legacy layout. Follow its RESTORE.md instead.`);
  }
  const backups = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  if (backups.length !== 1) throw new Error(`expected one backup in ${root}, found ${backups.length}`);
  return join(root, backups[0].name);
}

/** Raw-copied stores, as paths relative to the generation; refuses anything that is not a store path. */
function unmanagedStores(directory: string): string[] {
  const root = join(directory, UNMANAGED_STORES_DIR);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link ${path} in ${UNMANAGED_STORES_DIR}/`);
      if (entry.isDirectory()) { visit(path); continue; }
      const parts = path.split("/");
      const storePath = (parts[0] === "node" && parts.length === 3) || (parts[0] === "identities" && parts.length === 4);
      if (!storePath || !path.endsWith(".db") || !parts.every(part => generationIdentifier.test(part) && !part.includes(".."))) {
        throw new Error(`unexpected file ${path} in ${UNMANAGED_STORES_DIR}/`);
      }
      found.push(path);
    }
  };
  visit("");
  return found;
}

/** Copy one raw-copied store out of the backup and check the copy, so the backup itself is never opened. */
async function copyUnmanagedStore(directory: string, path: string, destination: string): Promise<void> {
  await copyFile(join(directory, UNMANAGED_STORES_DIR, path), destination, constants.COPYFILE_EXCL);
  const integrity = sqliteIntegrity(destination);
  if (integrity !== "ok") throw new Error(`${UNMANAGED_STORES_DIR}/${path} failed integrity_check: ${integrity.split("\n")[0]}`);
}

/**
 * Restore a `barry db backup` into a new store generation and switch to it.
 *
 * The current stores are backed up and the backup is verified while the
 * services still run. Then the running user services stop, the new generation
 * is built as a copy of the current one with every verified snapshot laid over
 * it and workflow runs paused, `active.json` moves, and the same services start
 * again. Nothing in the current generation is overwritten, and it stays on
 * disk; after a failure the services start again on it.
 */
export async function dbRestoreCommand(source: string, options: DbRestoreOptions = {}): Promise<void> {
  const directory = resolve(source);
  const backupDirectory = managedBackupDirectory(directory);
  const backup = BackupManifestSchema.parse(JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8")));
  const sourceNodes = new Set(backup.stores.map(entry => entry.manifest.node));
  if (sourceNodes.size !== 1) throw new Error("backup mixes stores from several installations");
  const [sourceNode] = sourceNodes;
  const extra = unmanagedStores(directory);
  const dataStores = backedUpDataStores(directory);

  const root = barryStoresDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let previousId: string;
  if (existsSync(join(root, "active.json"))) {
    previousId = String(JSON.parse(readFileSync(join(root, "active.json"), "utf8")).id);
  } else {
    // A fresh home: start from an empty generation. A home still on the legacy
    // layout has stores outside any generation, and switching it would hide them.
    const { sessionsDbPath } = await import("@barry-rocks/sessions-bag/store/sessions-db");
    const { store: identitiesStore } = await import("@barry-rocks/identities-bag");
    const legacy = [sessionsDbPath(), identitiesStore.path()].filter(path => existsSync(path));
    if (legacy.length) throw new Error(`this home keeps its stores on the legacy layout (${legacy.join(", ")}); restore into a fresh BARRY_HOME instead`);
    previousId = bootstrapStoreGeneration(root);
  }
  const previous = join(root, "generations", previousId);
  const current = readInstallationId(previous);
  if (current && current !== sourceNode && !options.replaceInstallation) {
    throw new Error(`this backup is from installation ${sourceNode}, and this home is installation ${current}. Pass --replace-installation to make this home that installation, or restore into a fresh BARRY_HOME.`);
  }

  const { registry, warning } = await managedStoreRegistry(sourceNode, previous);
  if (warning) throw new Error(`cannot read the installed bags, so the backup's stores cannot be checked against their declarations: ${warning}`);
  if (!current && readdirSync(previous).length) throw new Error("cannot snapshot current stores without an installation id");
  const { directory: snapshot, lines } = await snapshotStores();
  console.log(`Pre-restore snapshot created: ${snapshot}`);
  for (const line of lines) console.log(line);

  // A bad backup costs no downtime: everything in it is checked while the services still run.
  await validateBackup(backupDirectory, { root, registry, sourceNode });
  const checks = await mkdtemp(join(tmpdir(), "barry-restore-"));
  try { for (const path of extra) await copyUnmanagedStore(directory, path, join(checks, `${randomUUID()}.db`)); }
  finally { await rm(checks, { recursive: true, force: true }); }

  const workflowsKey = storeKey({ node: sourceNode, bag: "workflows", store: "workflows" });
  let pausedRuns = 0;
  const prepared = await switchStoreGeneration({ command: "Restore", previous, services: options.services,
    async switch(stopAgain) {
      // Preparing copies the current generation and refuses one that changes
      // underneath it, so the services writing to it are stopped first.
      const prepared = await prepareBackupGeneration(backupDirectory, {
        root, previousId, servicesStopped: true, registry, sourceNode,
        async finish(candidate, restored) {
          for (const path of extra) {
            const to = join(candidate, path), check = join(dirname(to), `.restore-${randomUUID()}.db`);
            await mkdir(dirname(to), { recursive: true, mode: 0o700 });
            try {
              await copyUnmanagedStore(directory, path, check);
              for (const suffix of ["", "-wal", "-shm"]) await rm(`${to}${suffix}`, { force: true });
              await copyFile(check, to, constants.COPYFILE_EXCL);
            } finally { await rm(check, { force: true }); }
          }
          // A restored workflows database names workers and attempts of an owner
          // that is gone. Fence it here, inside the candidate, so the receipt
          // seals the paused state rather than a copy that would resume effects.
          if (restored.some(snapshot => storeKey(snapshot.manifest) === workflowsKey)) {
            const path = join(candidate, "node", "workflows", "workflows.db");
            const db = new DatabaseSync(path);
            try {
              db.exec("PRAGMA busy_timeout=1000");
              pauseRestoredRuns(db);
              pausedRuns = Number(db.prepare("SELECT count(*) AS n FROM workflow_runs WHERE status='blocked'").get()?.n ?? 0);
            } finally { db.close(); }
          }
        },
      });
      await stopAgain();
      await activateStoreGeneration({
        root, id: prepared.id, previousId, servicesStopped: true, rollbackOnFailure: true,
        validate: async () => { await validatePreparedStoreGeneration(root, prepared.id); },
        sealPrevious: async () => {},
      });
      return prepared;
    },
  });
  console.log(`Restored ${backup.stores.length} stores${extra.length ? ` and ${extra.length} unmanaged` : ""} from ${directory}`);
  if (dataStores.length) {
    console.log("  not restored, kept outside the store generation (RESTORE.md says how to put one back):");
    for (const name of dataStores) {
      const [bag, file] = name.split("/");
      const nodeStore = join(prepared.directory, "node", bag, file);
      let destination = join(barryAppSupportDir(), "data", bag, file);
      if (existsSync(nodeStore)) {
        destination = nodeStore;
      } else {
        const idDir = join(prepared.directory, "identities");
        if (existsSync(idDir)) {
          for (const entry of readdirSync(idDir, { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(join(idDir, entry.name, bag, file))) {
              destination = join(idDir, entry.name, bag, file);
              break;
            }
          }
        }
      }
      console.log(`    unmanaged/data/${name} -> ${destination}`);
    }
  }
  console.log(`  active generation: ${prepared.directory}`);
  console.log(`  previous generation kept: ${previous}`);
  if (current && current !== sourceNode) console.log(`  installation id: ${current} -> ${sourceNode}`);
  if (pausedRuns) console.log(`  ${pausedRuns} workflow run(s) blocked (RecoveryPaused): reconcile their effects, then \`barry workflows resume <run>\``);
  for (const line of await pruneOlderGenerations(root)) console.log(line);
}
