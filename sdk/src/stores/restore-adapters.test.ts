import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { StoreRegistry, storePath } from "./registry.js";
import { sqliteProvider } from "./sqlite-provider.js";
import { loadDeclaredStores } from "./load.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(tmpdir(), "barry-restore-adapters-")); directories.push(path); return path; }
const declaration = { owned_by: "identity" as const, engine: "sqlite" as const, migrations: "local" };
async function fixture() {
  const root = scratch(), registry = new StoreRegistry("source", root), ref = { node: "source", identity: "alice", bag: "notes", store: "default" };
  registry.register("notes", "default", declaration, sqliteProvider([]));
  (await registry.open(ref)).close();
  const db = new DatabaseSync(storePath(ref, "identity", root));
  try { db.exec("CREATE TABLE notes(owner TEXT,value TEXT); INSERT INTO notes VALUES('alice','retained')"); } finally { db.close(); }
  return { snapshot: await registry.snapshot(ref, scratch()), registry };
}
it("prepares a plain SQLite backup independently and refuses occupied or mismatched-scope destinations", async () => {
  const { snapshot } = await fixture(), registry = new StoreRegistry("replacement", scratch()), destination = join(registry.root, "notes.db");
  registry.register("notes", "default", declaration, sqliteProvider([]));
  await registry.prepareRestore(snapshot, destination);
  const db = new DatabaseSync(destination, { readOnly: true });
  try { expect(db.prepare("SELECT * FROM notes").all()).toEqual([{ owner: "alice", value: "retained" }]); } finally { db.close(); }
  await expect(registry.prepareRestore(snapshot, destination)).rejects.toThrow(/already exists/);
  await expect(registry.prepareRestore(snapshot, "relative.db")).rejects.toThrow(/absolute/);
  const wrong = new StoreRegistry("replacement", scratch());
  wrong.register("notes", "default", { ...declaration, owned_by: "node" }, sqliteProvider([]));
  await expect(wrong.prepareRestore(snapshot, join(wrong.root, "wrong.db"))).rejects.toThrow(/cannot carry an identity/);
});
it("loads a contained local restore hook once and binds preparation to the destination node", async () => {
  const { snapshot } = await fixture(), root = scratch(), registry = new StoreRegistry("replacement", scratch());
  registry.register("notes", "default", declaration, sqliteProvider([]));
  writeFileSync(join(root, "restore.mjs"), `
    import {copyFile,chmod} from 'node:fs/promises'; import {constants} from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
    export async function prepareRestore(snapshot,ref,destination) {
      await copyFile(snapshot.path,destination,constants.COPYFILE_EXCL); await chmod(destination,0o600);
      const db=new DatabaseSync(destination); try {db.prepare('UPDATE notes SET value=?').run(ref.node);} finally {db.close();}
    }
  `);
  const bag = { name: "notes", source: { type: "local", path: root }, manifest: { stores: { default: declaration }, storeRestores: { default: { entry: "restore.mjs" } } } };
  await Promise.all([loadDeclaredStores(registry, [bag]), loadDeclaredStores(registry, [bag])]);
  const destination = join(registry.root, "prepared.db"); await registry.prepareRestore(snapshot, destination);
  const db = new DatabaseSync(destination, { readOnly: true });
  try { expect(db.prepare("SELECT * FROM notes").all()).toEqual([{ owner: "alice", value: "replacement" }]); } finally { db.close(); }
  writeFileSync(join(root, "changed.mjs"), "export async function prepareRestore(){}");
  await expect(loadDeclaredStores(registry, [{ ...bag, manifest: { ...bag.manifest, storeRestores: { default: { entry: "changed.mjs" } } } }])).rejects.toThrow(/restart/);
  expect(() => registry.registerRestoreAdapter("notes", "default", async () => {})).toThrow(/duplicate/);
});
it("refuses remote installation, missing exports, undeclared stores and entries escaping the local bag", async () => {
  const root = scratch(), outside = scratch(), registry = new StoreRegistry("replacement", scratch());
  registry.register("notes", "default", declaration, sqliteProvider([]));
  writeFileSync(join(outside, "restore.mjs"), "export async function prepareRestore(){}");
  writeFileSync(join(root, "bad.mjs"), "export const prepareRestore=42;");
  symlinkSync(join(outside, "restore.mjs"), join(root, "escaped.mjs"));
  mkdirSync(join(root, "directory.mjs"));
  const bag = (entry: string, stores: Record<string, typeof declaration> = { default: declaration }, type = "local") => ({ name: "notes", source: { type, path: root }, manifest: { stores, storeRestores: { default: { entry } } } });
  await loadDeclaredStores(registry, [bag("bad.mjs", undefined, "remote")]);
  expect(registry.hasRestoreAdapter("notes", "default")).toBe(false);
  await expect(loadDeclaredStores(registry, [bag("bad.mjs")])).rejects.toThrow(/must export/);
  await expect(loadDeclaredStores(registry, [bag("escaped.mjs")])).rejects.toThrow(/remain inside/);
  await expect(loadDeclaredStores(registry, [bag("directory.mjs")])).rejects.toThrow(/remain inside/);
  await expect(loadDeclaredStores(registry, [bag("../restore.mjs")])).rejects.toThrow(/inside the bag/);
  await expect(loadDeclaredStores(registry, [bag("bad.mjs", {})])).rejects.toThrow(/declared store/);
});
it("validates hook output before accepting a prepared catalog", async () => {
  const { snapshot } = await fixture(), registry = new StoreRegistry("replacement", scratch());
  registry.register("notes", "default", declaration, sqliteProvider([]));
  registry.registerRestoreAdapter("notes", "default", async (_snapshot, _ref, destination) => { writeFileSync(destination, "invalid catalog"); });
  await expect(registry.prepareRestore(snapshot, join(registry.root, "invalid.db"))).rejects.toThrow();
});

it("refuses a hook output with dangling foreign keys even when the catalog and schema are readable", async () => {
  const { snapshot } = await fixture(), registry = new StoreRegistry("replacement", scratch());
  registry.register("notes", "default", declaration, sqliteProvider([]));
  registry.registerRestoreAdapter("notes", "default", async (_snapshot, _ref, destination) => {
    const db = new DatabaseSync(destination);
    try { db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(42)"); } finally { db.close(); }
  });
  await expect(registry.prepareRestore(snapshot, join(registry.root, "dangling.db"))).rejects.toThrow(/foreign keys/);
});

it("refuses a hook that substitutes a symlink to an existing valid catalog", async () => {
  const { snapshot } = await fixture(), registry = new StoreRegistry("replacement", scratch());
  registry.register("notes", "default", declaration, sqliteProvider([]));
  registry.registerRestoreAdapter("notes", "default", async (_snapshot, _ref, destination) => { symlinkSync(snapshot.path, destination); });
  await expect(registry.prepareRestore(snapshot, join(registry.root, "symlink.db"))).rejects.toThrow(/regular file/);
});
