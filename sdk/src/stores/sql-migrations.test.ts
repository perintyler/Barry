import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { sqliteProvider } from "./sqlite-provider.js";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { loadSqlMigrations } from "./sql-migrations.js";
import { loadDeclaredStores } from "./load.js";
import { StoreRegistry } from "./registry.js";
const scratch = () => mkdtempSync(join(tmpdir(), "barry-sql-history-"));
function bag() {
  const root = scratch();
  mkdirSync(join(root, "migrations"));
  return root;
}
describe("SQL migration directories", () => {
  it("loads in numeric order and permits an empty history", () => {
    const root = bag();
    expect(loadSqlMigrations(root, "migrations")).toEqual([]);
    writeFileSync(join(root, "migrations/002_tags.sql"), "ALTER TABLE notes ADD COLUMN tags TEXT;");
    writeFileSync(join(root, "migrations/001_notes.sql"), "CREATE TABLE notes(id TEXT);");
    expect(loadSqlMigrations(root, "migrations").map((m) => m.name)).toEqual(["001_notes.sql", "002_tags.sql"]);
  });
  it.each([
    ["002_gap.sql", "SELECT 1", /consecutive/],
    ["001_initial.ts", "SELECT 1", /unsupported/],
    ["001_initial.down.sql", "SELECT 1", /unsupported/],
    ["001_initial.sql", " ", /empty/],
    ["001_initial.sql", "-- migrate:up\nSELECT 1", /up\/down/],
  ])("rejects invalid history %s", (name, sql, error) => {
    const root = bag();
    writeFileSync(join(root, "migrations", name), sql);
    expect(() => loadSqlMigrations(root, "migrations")).toThrow(error);
  });
  it("rejects malformed UTF-8 and comment-only files", () => {
    const root = bag();
    const file = join(root, "migrations/001_a.sql");
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => loadSqlMigrations(root, "migrations")).toThrow();
    writeFileSync(file, "-- No statements\n/* only comments */");
    expect(() => loadSqlMigrations(root, "migrations")).toThrow(/empty/);
  });
  it("refuses a newer recorded schema on readonly opens even with a stale version stamp", () => {
    const path = join(scratch(), "future.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(2); PRAGMA user_version=0;");
    db.close();
    expect(() => sqliteProvider([]).open(path, { readonly: true })).toThrow(/unsupported store schema 2/);
  });
  it("rejects duplicate versions", () => {
    const root = bag();
    for (const name of ["001_a.sql", "001_b.sql"]) writeFileSync(join(root, "migrations", name), "SELECT 1");
    expect(() => loadSqlMigrations(root, "migrations")).toThrow(/consecutive/);
  });
  it("rejects traversal, absolute paths, escaping directory and file symlinks", () => {
    const root = bag();
    const outside = bag();
    writeFileSync(join(outside, "migrations/001_a.sql"), "SELECT 1");
    expect(() => loadSqlMigrations(root, "../outside")).toThrow(/inside/);
    expect(() => loadSqlMigrations(root, join(outside, "migrations"))).toThrow(/relative/);
    symlinkSync(join(outside, "migrations"), join(root, "escape"));
    expect(() => loadSqlMigrations(root, "escape")).toThrow(/inside/);
    symlinkSync(join(outside, "migrations/001_a.sql"), join(root, "migrations/001_a.sql"));
    expect(() => loadSqlMigrations(root, "migrations")).toThrow(/inside/);
  });
  it("opens an installed bag copy from its SQL assets", async () => {
    const source = bag();
    writeFileSync(join(source, "migrations/001_notes.sql"), "CREATE TABLE notes(id TEXT);");
    const installed = join(scratch(), "installed");
    cpSync(source, installed, { recursive: true });
    const registry = new StoreRegistry("node", scratch());
    await loadDeclaredStores(registry, [{ name: "notes", source: { type: "local", path: installed }, manifest: { stores: { notes: { owned_by: "identity", engine: "sqlite", migrations: "./migrations" } } } }]);
    const handle = await registry.open({ node: "node", identity: "alice", bag: "notes", store: "notes" });
    try { expect(handle.schemaVersion()).toBe(1); } finally { handle.close(); }
  });
});

describe("installed snapshot hooks", () => {
  function inventory(root: string, entry = "./snapshot.mjs") {
    return [{ name: "notes", source: { type: "local", path: root }, manifest: { stores: { default: { owned_by: "identity" as const, engine: "sqlite" as const, migrations: "./migrations" } }, storeSnapshots: { default: { entry } } } }];
  }
  it("loads installed JavaScript and coalesces concurrent/repeated registration", async () => {
    const root = bag();
    writeFileSync(join(root, "snapshot.mjs"), `import { DatabaseSync } from 'node:sqlite'; export async function captureSnapshot(ref, source, destination) {
      if(ref.identity !== 'alice') throw new Error('wrong capture identity');
      const db = new DatabaseSync(source,{readOnly:true}); try {db.prepare('VACUUM INTO ?').run(destination);} finally {db.close();} return [];
    }`);
    const registry = new StoreRegistry("node", scratch());
    await Promise.all([loadDeclaredStores(registry, inventory(root)), loadDeclaredStores(registry, inventory(root))]);
    await loadDeclaredStores(registry, inventory(root));
    expect(registry.hasSnapshotAdapter("notes", "default")).toBe(true);
    const ref = { node: "node", identity: "alice", bag: "notes", store: "default" };
    (await registry.open(ref)).close();
    const snapshot = await registry.snapshot(ref, scratch());
    expect(snapshot.manifest.resources).toEqual([]);
    const other = join(root, "other.mjs"); writeFileSync(other, "export async function captureSnapshot() {return []}");
    await expect(loadDeclaredStores(registry, inventory(root, "./other.mjs"))).rejects.toThrow(/changed.*restart/);
  });
  it("rejects remote, traversal and symlink escapes before importing code", async () => {
    const root = bag(), outside = scratch(), module = join(outside, "evil.mjs");
    writeFileSync(module, "throw new Error('untrusted module executed')"); symlinkSync(module, join(root, "escape.mjs"));
    for (const entry of ["./escape.mjs", "../evil.mjs", module, "https://example.invalid/snapshot.mjs"]) {
      await expect(loadDeclaredStores(new StoreRegistry("node", scratch()), inventory(root, entry))).rejects.toThrow(/inside the bag|inside the bag root/);
    }
  });
  it("recovers from missing exports without marking an adapter installed", async () => {
    const root = bag(), registry = new StoreRegistry("node", scratch());
    writeFileSync(join(root, "snapshot.mjs"), "export const captureSnapshot = null");
    await expect(loadDeclaredStores(registry, inventory(root))).rejects.toThrow(/export captureSnapshot/);
    expect(registry.hasSnapshotAdapter("notes", "default")).toBe(false);
    writeFileSync(join(root, "fixed.mjs"), "export async function captureSnapshot(){return []}");
    await loadDeclaredStores(registry, inventory(root, "./fixed.mjs"));
    expect(registry.hasSnapshotAdapter("notes", "default")).toBe(true);
  });
});
