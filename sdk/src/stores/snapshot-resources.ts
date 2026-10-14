import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SqliteDatabase as DatabaseSync, withSqliteInspectionCopy } from "./sqlite-connection.js";
import { SnapshotResourceSchema, type SnapshotResource } from "./snapshots.js";
import { validateSnapshot, type StoreSnapshot } from "./registry.js";

export function snapshotRevision(checksum: string, resources?: SnapshotResource[]): string {
    if (!resources?.length) return checksum;
    const canonical = resources.map(resource => ({ name: resource.name, files: [...resource.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return createHash("sha256").update(JSON.stringify({ checksum, resources: canonical })).digest("hex");
}

async function resourceFile(database: string, resource: SnapshotResource, relative: string): Promise<string> {
    let path = `${database}.resources`;
    for (const part of ["", resource.name, ...relative.split("/").slice(0, -1)]) {
        if (part) path = join(path, part);
        const directory = await lstat(path);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe snapshot resource directory");
    }
    return join(path, relative.split("/").at(-1)!);
}

export async function digestSnapshotFile(path: string, destination?: string): Promise<{ bytes: number; checksum: string }> {
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
        const before = await source.stat();
        if (!before.isFile()) throw new Error("snapshot resource must be a regular file");
        if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(65536);
        let bytes = 0;
        for (;;) {
            const chunk = await source.read(buffer, 0, buffer.length, null);
            if (!chunk.bytesRead) break;
            bytes += chunk.bytesRead;
            hash.update(buffer.subarray(0, chunk.bytesRead));
            if (output) {
                let written = 0;
                while (written < chunk.bytesRead) {
                    const result = await output.write(buffer, written, chunk.bytesRead - written, null);
                    if (!result.bytesWritten) throw new Error("snapshot resource write made no progress");
                    written += result.bytesWritten;
                }
            }
        }
        const after = await source.stat(), current = await lstat(path);
        if (before.size !== bytes || after.size !== before.size || before.mtimeMs !== after.mtimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)
            throw new Error("snapshot resource changed during capture");
        if (output) { await output.chmod(0o400); await output.sync(); }
        return { bytes, checksum: hash.digest("hex") };
    } finally {
        await output?.close();
        await source.close();
    }
}

export async function validateSnapshotResources(snapshot: StoreSnapshot): Promise<void> {
    const resources = snapshot.manifest.resources ?? [];
    const file = await lstat(snapshot.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("unsafe snapshot database");
    await withSqliteInspectionCopy(snapshot.path, async copy => {
        const database = new DatabaseSync(copy, { readOnly: true });
        try {
            database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
            const declared = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_resource_requirements'").get();
            if (declared) {
                for (const required of database.prepare("SELECT name FROM store_resource_requirements").all()) {
                    if (!resources.some(resource => resource.name === required.name)) throw new Error("snapshot omits required resource content");
                }
                const indexed = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_snapshot_files'").get();
                if (!indexed) throw new Error("snapshot omits its catalog resource index");
                const actual = resources.flatMap(resource => resource.files.map(file => ({ resource: resource.name, ...file })))
                    .sort((a, b) => a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
                const expected = database.prepare("SELECT resource,path,bytes,checksum FROM store_snapshot_files ORDER BY resource,path LIMIT ?").all(actual.length + 1);
                if (expected.length !== actual.length || expected.some((file, index) => file.resource !== actual[index].resource || file.path !== actual[index].path || file.bytes !== actual[index].bytes || file.checksum !== actual[index].checksum))
                    throw new Error("snapshot resources do not match the catalog index");
            }
        } finally { database.close(); }
    });
    if (resources.length && snapshot.manifest.revision !== snapshotRevision(snapshot.manifest.checksum, resources)) throw new Error("snapshot resource revision mismatch");
    for (const resource of resources) {
        SnapshotResourceSchema.parse(resource);
        await resourceFile(snapshot.path, resource, "placeholder");
        for (const entry of resource.files) {
            const digest = await digestSnapshotFile(await resourceFile(snapshot.path, resource, entry.path));
            if (digest.bytes !== entry.bytes || digest.checksum !== entry.checksum) throw new Error("snapshot resource integrity mismatch");
        }
    }
}

export async function copySnapshot(snapshot: StoreSnapshot, destination: string): Promise<void> {
    await validateSnapshot(snapshot);
    const database = await digestSnapshotFile(snapshot.path, destination);
    if (database.bytes !== snapshot.manifest.bytes || database.checksum !== snapshot.manifest.checksum) throw new Error("snapshot integrity mismatch during copy");
    if (snapshot.manifest.resources?.length) await mkdir(`${destination}.resources`, { mode: 0o700 });
    const directories = new Set<string>();
    for (const resource of snapshot.manifest.resources ?? []) {
        const root = join(`${destination}.resources`, resource.name);
        await mkdir(root, { mode: 0o700 });
        directories.add(root);
        for (const entry of resource.files) {
            const target = join(`${destination}.resources`, resource.name, entry.path);
            let parent = root;
            for (const part of entry.path.split("/").slice(0, -1)) {
                parent = join(parent, part);
                if (!directories.has(parent)) { await mkdir(parent, { mode: 0o700 }); directories.add(parent); }
            }
            const digest = await digestSnapshotFile(await resourceFile(snapshot.path, resource, entry.path), target);
            if (digest.bytes !== entry.bytes || digest.checksum !== entry.checksum) throw new Error("snapshot resource integrity mismatch during copy");
        }
    }
    await validateSnapshot({ path: destination, manifest: snapshot.manifest });
    if (snapshot.manifest.resources?.length) directories.add(`${destination}.resources`);
    directories.add(dirname(destination));
    for (const path of directories) {
        const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
    }
}

export async function snapshotFile(snapshot: StoreSnapshot, resource?: { name: string; path: string }): Promise<{ path: string; bytes: number }> {
    if (!resource) return { path: snapshot.path, bytes: snapshot.manifest.bytes };
    const declared = snapshot.manifest.resources?.find(entry => entry.name === resource.name);
    const file = declared?.files.find(entry => entry.path === resource.path);
    if (!declared || !file) throw new Error("snapshot resource is not declared");
    return { path: await resourceFile(snapshot.path, declared, file.path), bytes: file.bytes };
}
