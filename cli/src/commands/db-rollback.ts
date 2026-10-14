import { pruneOlderGenerations } from "./db-prune.js";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readInstallationId } from "@barry-rocks/sdk/internal/nodes";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { activateStoreGeneration, prepareStoreGeneration, previousStoreGeneration, validatePreparedStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { assertStoreSpace, snapshotStores } from "./db-stores.js";
import { switchStoreGeneration, type StoreServices } from "./db-services.js";

export function generationSize(directory: string): { bytes: number; databases: number } {
  let bytes = 0, databases = 0;
  function visit(relative: string): void {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`unsupported store generation entry ${path}`);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) throw new Error(`unsupported store generation entry ${path}`);
      bytes += lstatSync(join(directory, path)).size;
      const parts = path.split("/");
      if (path.endsWith(".db") && (parts[0] === "node" && parts.length === 3 || parts[0] === "identities" && parts.length === 4)) databases++;
    }
  }
  visit("");
  return { bytes, databases };
}

export async function dbRollbackCommand(options: {
  yes?: boolean; services?: StoreServices; confirm?(message: string): Promise<boolean>;
} = {}): Promise<void> {
  const root = barryStoresDir(), previous = previousStoreGeneration(root);
  if (!previous) throw new Error("No earlier store generation is recorded for this home: its active generation was made before activations were journaled, or it has never switched. Restore a backup with `barry db restore <backup>` instead.");
  const outgoing = join(root, "generations", previous.replacedBy), source = join(root, "generations", previous.id);
  // The snapshot skips every store of a generation with no installation id; only an empty one has nothing to keep.
  if (!readInstallationId(outgoing) && readdirSync(outgoing).length) throw new Error("cannot snapshot current stores without an installation id");
  const size = generationSize(source), time = previous.replacedAt.toISOString();
  console.log(`Active generation: ${previous.replacedBy}, active since ${time}`);
  console.log(`Previous generation: ${previous.id} (${size.databases} store databases)`);
  const lostWrites = `Writes since ${time} stop being used, but stay in ${outgoing} and in the snapshot.`;
  console.log(lostWrites);
  console.log("Services restart on the code installed now. After a migration, install the matching code first, or services will migrate the copy forward again.");
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Unattended rollback requires --yes");
    const message = `Roll back active generation ${previous.replacedBy} (active since ${time}) to a copy of ${previous.id}? ${lostWrites}`;
    const confirmed = options.confirm ? await options.confirm(message) : await (await import("@inquirer/prompts")).confirm({ message, default: false });
    if (!confirmed) { console.log("No changes made."); return; }
  }
  const snapshot = await snapshotStores();
  console.log(`Pre-rollback snapshot created: ${snapshot.directory}`);
  for (const line of snapshot.lines) console.log(line);
  assertStoreSpace(size.bytes, root, "a rollback generation");
  // No service writes this source; preparation also refuses a source that changes.
  const candidate = await prepareStoreGeneration({ root, previousId: previous.replacedBy, source: previous.id, servicesStopped: true });
  await validatePreparedStoreGeneration(root, candidate.id);
  const prepared = await switchStoreGeneration({ command: "Rollback", previous: outgoing, services: options.services,
    async switch(stopAgain) {
      await stopAgain();
      await activateStoreGeneration({ root, id: candidate.id, previousId: previous.replacedBy, servicesStopped: true, rollbackOnFailure: true,
        validate: async () => { await validatePreparedStoreGeneration(root, candidate.id); },
        sealPrevious: async () => {},
      });
      return candidate;
    },
  });
  console.log(`Rolled back to ${prepared.directory}, a copy of ${source}`);
  console.log(`  generation left kept: ${outgoing}`);
  console.log(`  snapshot: ${snapshot.directory}`);
  console.log(`Undo with \`barry db rollback\` again, or \`barry db restore ${snapshot.directory}\`.`);
  for (const line of await pruneOlderGenerations(root)) console.log(line);
}
