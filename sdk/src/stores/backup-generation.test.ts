import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBackup } from "./backups.js";
import { prepareBackupGeneration } from "./backup-generation.js";
import { StoreRegistry, storePath } from "./registry.js";
import { sqliteProvider } from "./sqlite-provider.js";
import { validatePreparedStoreGeneration } from "./generation-preparation.js";
import { activeStoreRoot } from "./migration.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function scratch() { const root = mkdtempSync(join(tmpdir(), "barry-backup-generation-")); directories.push(root); return root; }
async function fixture() {
  const root = scratch(), previous = join(root, "generations/previous"), registry = new StoreRegistry("desktop", previous);
  registry.register("notes", "default", { owned_by: "identity", engine: "sqlite", migrations: "local" }, sqliteProvider([]));
  const ref = { node: "desktop", identity: "alice", bag: "notes", store: "default" };
  (await registry.open(ref)).close();
  const path = storePath(ref, "identity", previous), database = new DatabaseSync(path);
  try { database.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('backup')"); } finally { database.close(); }
  const backups = scratch(), backup = await createBackup([await registry.snapshot(ref, scratch())], { root: backups });
  const writer = new DatabaseSync(path);
  try { writer.exec("UPDATE notes SET value='current'"); } finally { writer.close(); }
  const memory = join(previous, "identities/alice/memory/default.db"); mkdirSync(dirname(memory), { recursive: true });
  const memoryDb = new DatabaseSync(memory); try { memoryDb.exec("CREATE TABLE memory(value TEXT); INSERT INTO memory VALUES('permanent')"); } finally { memoryDb.close(); }
  writeFileSync(join(previous, "unknown.bin"), Buffer.from([0, 255, 13, 128]));
  writeFileSync(join(previous, "identities/alice/notes/default.db.unrelated"), "retain this file");
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "previous" }));
  return { root, previous, registry, ref, path, directory: join(backups, backup.id) };
}
it("overlays a verified backup while retaining non-backup stores and unknown files without selecting the candidate", async () => {
  const source = await fixture(), selector = readFileSync(join(source.root, "active.json"));
  const prepared = await prepareBackupGeneration(source.directory, { ...source, previousId: "previous", servicesStopped: true });
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
  const database = new DatabaseSync(storePath(source.ref, "identity", prepared.directory), { readOnly: true });
  try { expect(database.prepare("SELECT value FROM notes").get()?.value).toBe("backup"); } finally { database.close(); }
  const original = new DatabaseSync(source.path, { readOnly: true }), memory = new DatabaseSync(join(prepared.directory, "identities/alice/memory/default.db"), { readOnly: true });
  try { expect(original.prepare("SELECT value FROM notes").get()?.value).toBe("current"); expect(memory.prepare("SELECT value FROM memory").get()?.value).toBe("permanent"); } finally { original.close(); memory.close(); }
  expect(readFileSync(join(prepared.directory, "unknown.bin"))).toEqual(readFileSync(join(source.previous, "unknown.bin")));
  expect(readFileSync(join(prepared.directory, "identities/alice/notes/default.db.unrelated"), "utf8")).toBe("retain this file");
  expect(readFileSync(join(source.root, "active.json"))).toEqual(selector); expect(activeStoreRoot(source.root)).toBe(source.previous);
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
});
it("refuses stopped-state, duplicate destinations, mixed nodes and corrupt backups before preparation", async () => {
  const source = await fixture(), manifestPath = join(source.directory, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const options = { ...source, previousId: "previous", servicesStopped: true };
  await expect(prepareBackupGeneration(source.directory, { ...options, servicesStopped: false })).rejects.toThrow(/stop/);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, stores: [...manifest.stores, manifest.stores[0]] }));
  await expect(prepareBackupGeneration(source.directory, options)).rejects.toThrow(/duplicate/);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, stores: [{ ...manifest.stores[0], manifest: { ...manifest.stores[0].manifest, node: "different" } }] }));
  await expect(prepareBackupGeneration(source.directory, options)).rejects.toThrow(/source node/);
  writeFileSync(manifestPath, JSON.stringify(manifest)); chmodSync(join(source.directory, "0.db"), 0o600); writeFileSync(join(source.directory, "0.db"), "corrupt");
  await expect(prepareBackupGeneration(source.directory, options)).rejects.toThrow(/integrity/);
  expect(readdirSync(join(source.root, "generations"))).toEqual(["previous"]);
});
it("a failing or out-of-bundle adapter cannot activate a partial replacement or change old stores", async () => {
  for (const extra of [false, true]) {
    const source = await fixture();
    source.registry.registerRestoreAdapter("notes", "default", async (_snapshot, _ref, destination) => {
      writeFileSync(destination, "partial");
      if (!extra) throw new Error("interrupted hook");
      copyFileSync(_snapshot.path, destination);
      writeFileSync(join(dirname(destination), "another-store.db"), "unowned");
    });
    await expect(prepareBackupGeneration(source.directory, { ...source, previousId: "previous", servicesStopped: true })).rejects.toThrow(extra ? /outside its store bundle/ : /interrupted hook/);
    expect(activeStoreRoot(source.root)).toBe(source.previous);
    const original = new DatabaseSync(source.path, { readOnly: true });
    try { expect(original.prepare("SELECT value FROM notes").get()?.value).toBe("current"); } finally { original.close(); }
    expect(existsSync(join(source.previous, "unknown.bin"))).toBe(true);
  }
});
