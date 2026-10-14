import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SnapshotManifestSchema } from "./snapshots.js";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { StoreRegistry, validateSnapshot, storePath, installSnapshot } from "./registry.js";
import { sqliteProvider } from "./sqlite-provider.js";
import { migrateLegacyStores, activeStoreRoot } from "./migration.js";
import { createBackup } from "./backups.js";
const scratch = () => mkdtempSync(join(tmpdir(), "barry-store-resources-"));
describe("declared stores", () => {
    it("isolates identities and captures WAL writes", async () => {
        const root = scratch();
        const registry = new StoreRegistry("desktop", root);
        registry.register("todos", "todos", { owned_by: "identity", engine: "sqlite", migrations: "./migrations" }, sqliteProvider([{ name: "1", sql: "CREATE TABLE todos(id TEXT PRIMARY KEY)" }]));
        const ref = { node: "desktop", identity: "coder", bag: "todos", store: "todos" };
        const handle = await registry.open(ref);
        handle.close();
        const db = new DatabaseSync(storePath(ref, "identity", root));
        db.exec("PRAGMA journal_mode=WAL; INSERT INTO todos VALUES('one')");
        const snapshot = await registry.snapshot(ref, scratch());
        await validateSnapshot(snapshot);
        const copy = new DatabaseSync(snapshot.path);
        expect(copy.prepare("SELECT * FROM todos").all()).toEqual([{ id: "one" }]);
        copy.close();
        db.close();
        expect(() => storePath({ ...ref, identity: "../wrong" }, "identity", root)).toThrow();
        writeFileSync(snapshot.path, "broken");
        await expect(validateSnapshot(snapshot)).rejects.toThrow(/integrity/);
    });
    it("splits records, archives unknown ownership, and preserves originals", async () => {
        const root = scratch();
        const path = join(root, "old.db");
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY, owner TEXT); INSERT INTO rows VALUES(1,'alice'),(2,'bob'),(3,NULL)");
        db.close();
        const original = readFileSync(path);
        const report = await migrateLegacyStores([{ bag: "memory", store: "memory", path, owner: (_table, row) => typeof row.owner === "string" ? row.owner : undefined }], { servicesStopped: true, root: join(root, "new"), archives: join(root, "archives") });
        expect(report.archived).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(root, "new", "activations", `${report.id}.json`), "utf8")).state).toBe("active");
        expect(JSON.parse(readFileSync(report.reportPath, "utf8")).state).toBe("active");
        expect(readFileSync(path)).toEqual(original);
        const copy = new DatabaseSync(join(activeStoreRoot(join(root, "new")), "identities", "alice", "memory", "memory.db"));
        expect(copy.prepare("SELECT id FROM rows").all()).toEqual([{ id: 1 }]);
        copy.close();
        await expect(migrateLegacyStores([], { servicesStopped: false })).rejects.toThrow(/stop/);
    });
    it("rejects a corrupt backup snapshot", async () => {
        const root = scratch();
        const registry = new StoreRegistry("desktop", root);
        registry.register("todos", "todos", { owned_by: "identity", engine: "sqlite", migrations: "./migrations" }, sqliteProvider([]));
        const ref = { node: "desktop", identity: "coder", bag: "todos", store: "todos" };
        const handle = await registry.open(ref);
        handle.close();
        const snapshot = await registry.snapshot(ref, scratch());
        const backups = scratch();
        const backup = await createBackup([snapshot], { root: backups });
        chmodSync(join(backups, backup.id, "0.db"), 0o600);
        writeFileSync(join(backups, backup.id, "0.db"), "broken");
        await expect(validateSnapshot({ path: join(backups, backup.id, "0.db"), manifest: snapshot.manifest })).rejects.toThrow(/integrity/);
    });
});
describe("migration recovery and derived indexes", () => {
    it("resumes from the immutable archive and rebuilds external-content FTS", async () => {
        const directory = scratch();
        const path = join(directory, "old.db");
        const db = new DatabaseSync(path);
        db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,owner TEXT,text TEXT); CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='messages',content_rowid='id'); INSERT INTO messages VALUES(1,'alice','original'),(2,'bob','different'); INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
        db.close();
        const options = { servicesStopped: true, id: "resume", root: join(directory, "stores"), archives: join(directory, "archives") };
        await expect(migrateLegacyStores([{ bag: "sessions", store: "sessions", path, owner: () => { throw new Error("interruption"); } }], options)).rejects.toThrow(/interruption/);
        // The home stays on the legacy layout: no selector hides its stores.
        expect(existsSync(join(options.root, "active.json"))).toBe(false);
        const changed = new DatabaseSync(path);
        changed.exec("UPDATE messages SET text='changed' WHERE id=1");
        changed.close();
        await migrateLegacyStores([{ bag: "sessions", store: "sessions", path, owner: (_table, row) => String(row.owner) }], options);
        const sources = [{ bag: "sessions", store: "sessions", path, owner: (_table: string, row: Record<string, unknown>) => String(row.owner) }];
        expect((await migrateLegacyStores(sources, options)).state).toBe("active");
        // Repeating an already activated migration leaves the generation intact.
        expect((await migrateLegacyStores(sources, options)).state).toBe("active");
        const copy = new DatabaseSync(join(activeStoreRoot(options.root), "identities", "alice", "sessions", "sessions.db"));
        try {
            expect(copy.prepare("SELECT text FROM messages").all()).toEqual([{ text: "original" }]);
            expect(copy.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'original'").all()).toEqual([{ rowid: 1 }]);
            expect(copy.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'different'").all()).toEqual([]);
        }
        finally {
            copy.close();
        }
    });
});


describe("snapshot companion resources", () => {
    async function capture() {
        const root = scratch(), registry = new StoreRegistry("desktop", root);
        const ref = { node: "desktop", identity: "coder", bag: "files", store: "default" };
        const provider = sqliteProvider([{ name: "1", sql: "CREATE TABLE store_resource_requirements(name TEXT PRIMARY KEY); INSERT INTO store_resource_requirements VALUES('blobs');" }]);
        const bytes = Buffer.from("immutable content"), checksum = createHash("sha256").update(bytes).digest("hex");
        registry.register("files", "default", { owned_by: "identity", engine: "sqlite", migrations: "local" }, {
            migrations: provider.migrations,
            open(path, options) {
                const handle = provider.open(path, options);
                if (handle instanceof Promise) throw new Error("expected synchronous SQLite provider");
                return { ...handle, async snapshot(destination) {
                    const db = new DatabaseSync(path, { readOnly: true });
                    try { db.prepare("VACUUM INTO ?").run(destination); } finally { db.close(); }
                    const captured = new DatabaseSync(destination);
                    try {
                        captured.exec("CREATE TABLE store_snapshot_files(resource TEXT,path TEXT,bytes INTEGER,checksum TEXT,PRIMARY KEY(resource,path)) STRICT");
                        captured.prepare("INSERT INTO store_snapshot_files VALUES('blobs',?,?,?)").run(`sha256/${checksum}`, bytes.length, checksum);
                    } finally { captured.close(); }
                    mkdirSync(`${destination}.resources/blobs/sha256`, { recursive: true, mode: 0o700 });
                    writeFileSync(`${destination}.resources/blobs/sha256/${checksum}`, bytes, { mode: 0o400 });
                    return [{ name: "blobs", files: [{ path: `sha256/${checksum}`, bytes: bytes.length, checksum }] }];
                } };
            },
        });
        (await registry.open(ref)).close();
        return { snapshot: await registry.snapshot(ref, scratch()), bytes, checksum };
    }
    it("copies complete resources into independent installed generations and backups", async () => {
        const { snapshot, bytes, checksum } = await capture();
        expect(snapshot.manifest.revision).not.toBe(snapshot.manifest.checksum);
        const installed = await installSnapshot(snapshot, scratch());
        const backupRoot = scratch(), backup = await createBackup([snapshot], { root: backupRoot });
        unlinkSync(`${snapshot.path}.resources/blobs/sha256/${checksum}`);
        await validateSnapshot(installed);
        expect(readFileSync(`${installed.path}.resources/blobs/sha256/${checksum}`)).toEqual(bytes);
        const path = join(backupRoot, backup.id, "0.db");
        await validateSnapshot({ path, manifest: snapshot.manifest });
        expect(readFileSync(`${path}.resources/blobs/sha256/${checksum}`)).toEqual(bytes);
    });
    it("rejects missing required resources and substituted bytes", async () => {
        const { snapshot, checksum } = await capture();
        await expect(validateSnapshot({ ...snapshot, manifest: { ...snapshot.manifest, resources: undefined } })).rejects.toThrow(/omits required/);
        const path = `${snapshot.path}.resources/blobs/sha256/${checksum}`;
        chmodSync(path, 0o600);
        writeFileSync(path, "different content");
        await expect(validateSnapshot(snapshot)).rejects.toThrow(/resource integrity/);
        await expect(createBackup([snapshot], { root: scratch() })).rejects.toThrow(/resource integrity/);
    });
    it("refuses resource file symlinks and changed resource descriptors", async () => {
        const { snapshot, checksum, bytes } = await capture();
        const path = `${snapshot.path}.resources/blobs/sha256/${checksum}`, target = join(scratch(), "outside");
        writeFileSync(target, bytes);
        unlinkSync(path); symlinkSync(target, path);
        await expect(validateSnapshot(snapshot)).rejects.toThrow();
        const resources = [{ name: "blobs", files: [] }];
        await expect(validateSnapshot({ ...snapshot, manifest: { ...snapshot.manifest, resources } })).rejects.toThrow(/catalog index/);
    });
    it("rejects traversal and duplicate manifest entries", async () => {
        const { snapshot } = await capture();
        const file = snapshot.manifest.resources![0].files[0];
        for (const path of ["../outside", "/outside", "a//b", "a/./b", "a/../b", "a\\b"]) {
            expect(SnapshotManifestSchema.safeParse({ ...snapshot.manifest, resources: [{ name: "blobs", files: [{ ...file, path }] }] }).success).toBe(false);
        }
        expect(SnapshotManifestSchema.safeParse({ ...snapshot.manifest, resources: [{ name: "blobs", files: [file, file] }] }).success).toBe(false);
        expect(SnapshotManifestSchema.safeParse({ ...snapshot.manifest, resources: [snapshot.manifest.resources![0], snapshot.manifest.resources![0]] }).success).toBe(false);
    });
});
