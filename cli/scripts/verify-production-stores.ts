import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { coreProvider } from "../src/services/configuration/index.js";
/** Verify copied production stores. Never opens the source writable or starts services. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as sqlite from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateBuiltinStores } from "../src/commands/store-migrate.js";

import { activeStoreRoot, type MigrationReport, createBackup, validateSnapshot, type StoreSnapshot, loadSqlMigrations } from "@barry-rocks/sdk/internal/stores";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";



import { migrateStore } from "@barry-rocks/sdk/stores";

// Runtime is Node 26; the workspace currently uses Node 22 declarations.
const { backup } = sqlite as typeof sqlite & { backup(db: DatabaseSync, destination: string): Promise<void> };
const repo = fileURLToPath(new URL("../..", import.meta.url));
const resume = process.argv[2] === "--resume";
const root = resume ? process.argv[3] : mkdtempSync(join(tmpdir(), "barry-production-verification-"));
const previous = resume ? JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as { source: string; captures: { path: string; bytes: number; checksum: string }[] } : undefined;
const source = previous?.source ?? process.argv[2] ?? barryAppSupportDir();
chmodSync(root, 0o700);
const home = join(root, "instance");
for (const key of Object.keys(process.env)) if (key.startsWith("BARRY_")) delete process.env[key];
process.env.BARRY_HOME = home;
process.env.BARRY_BUILTIN_DIR = join(repo, "bags");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const report: Record<string, unknown> = { root, source, limitations: ["Each database is a consistent SQLite backup; capture across live databases is not atomic", "Vaults, adapter databases and external bag databases are outside this migration"] };
const paths = ["config.db", ...["sessions", "memory", "todos", "events", "actions", "embeddings", "decisions", "schedules", "identities"].map((bag) => `data/${bag}/${bag}.db`), ...["locks/locks", "tracker/file-tracker", "telemetry/metrics", "telemetry/usage", "telemetry/requests", "telemetry/errors", "logs/logs"].map((name) => `data/${name}.db`)];
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith(".db") ? [join(directory, entry.name)] : []);
function ordinary(db: DatabaseSync): string[] {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
    const virtual = tables.filter((table) => /CREATE VIRTUAL TABLE/i.test(table.sql));
    return tables.filter((table) => table.name !== "schema_migrations" && !virtual.some((v) => table.name === v.name || table.name.startsWith(`${v.name}_`))).map((table) => table.name);
}
const modulus = 1n << 256n;
function digestRow(row: Record<string, unknown>): bigint {
    const text = JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key] instanceof Uint8Array ? { blob: Buffer.from(row[key] as Uint8Array).toString("base64") } : row[key]]));
    return BigInt(`0x${createHash("sha256").update(text).digest("hex")}`);
}
function fingerprint(db: DatabaseSync, table: string): { count: number; sum: bigint } {
    let count = 0, sum = 0n;
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).iterate()) { count++; sum = (sum + digestRow(row)) % modulus; }
    return { count, sum };
}
function healthy(path: string): void {
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok", path); assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0, path); }
    finally { db.close(); }
}
try {
    const captures: { path: string; bytes: number; checksum: string }[] = previous?.captures ?? [];
    for (const path of resume ? [] : paths) {
        const original = join(source, path);
        if (!existsSync(original)) continue;
        const copied = join(home, "app-support", path);
        mkdirSync(join(copied, ".."), { recursive: true, mode: 0o700 });
        const db = new DatabaseSync(original, { readOnly: true });
        try { await backup(db, copied); } finally { db.close(); }
        chmodSync(copied, 0o600);
        healthy(copied);
        captures.push({ path, bytes: statSync(copied).size, checksum: sha(copied) });
        console.log(`Captured ${path}`);
    }
    report.captures = captures;
    const marker = join(home, "app-support/stores/active.json");
    const migrationId = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")).id as string : undefined;
    const migration = await migrateBuiltinStores(true, migrationId);
    const migrated = JSON.parse(readFileSync(migration.reportPath, "utf8")) as MigrationReport;
    console.log("Migration activated; checking row preservation");
    report.migration = { state: migrated.state, tables: migrated.tables, archivedRows: migrated.archived.length };
    assert.equal(migrated.state, "active");
    for (const capture of captures) {
        const path = join(home, "app-support", capture.path);
        if (existsSync(path)) assert.equal(sha(path), capture.checksum, "copied originals changed");
        else assert(resume, "missing copied original");
    }
    const generation = activeStoreRoot();
    const outputs = walk(generation);
    for (const output of outputs) healthy(output);
    // Independent row fingerprints check all columns, including binary vectors.
    const checks = [];
    for (const original of migrated.originals) {
        const ref = original.archive.split("/").at(-1)!.replace(/\.db$/, "");
        const split = ref.indexOf("-");
        const bag = ref.slice(0, split), store = ref.slice(split + 1);
        const db = new DatabaseSync(original.archive, { readOnly: true });
        try {
            const nodeStore = bag === "sessions" ? "catalog" : bag === "actions" ? "infrastructure" : bag === "embeddings" ? "unscoped" : store;
            const partitions = outputs.filter((path) => {
                const parts = relative(generation, path).split("/");
                return parts.at(-2) === bag && parts.at(-1) === `${parts[0] === "node" ? nodeStore : store}.db`;
            });
            for (const table of ordinary(db)) {
                const expected = fingerprint(db, table);
                const blobColumns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter((column) => String(column.type).toUpperCase() === "BLOB").map((column) => String(column.name));
                let count = 0, sum = 0n;
                // Read-only prerequisites deliberately replicate into identity partitions.
                const replicated = (bag === "sessions" && ["agent_adapters", "providers", "models"].includes(table)) || (bag === "embeddings" && table === "collections");
                for (const partition of partitions) {
                    if (replicated && !relative(generation, partition).startsWith("node/")) continue;
                    const output = new DatabaseSync(partition, { readOnly: true });
                    try { const actual = fingerprint(output, table); count += actual.count; sum = (sum + actual.sum) % modulus; }
                    finally { output.close(); }
                }
                for (const archived of migrated.archived.filter((entry) => entry.store === `${bag}/${store}` && entry.table === table)) {
                    // JSON reports serialize Uint8Array blobs as objects keyed by byte
                    // index. Restore their byte representation when resuming verification.
                    const row = { ...archived.row };
                    for (const column of blobColumns) {
                        const value = row[column];
                        if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
                            const bytes = Object.entries(value).sort(([a], [b]) => Number(a) - Number(b));
                            assert(bytes.every(([key, byte], index) => key === String(index) && Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255), `invalid archived blob ${bag}/${table}/${column}`);
                            row[column] = Uint8Array.from(bytes.map(([, byte]) => Number(byte)));
                        }
                    }
                    count++; sum = (sum + digestRow(row)) % modulus;
                }
                assert.equal(count, expected.count, `${bag}/${table} row count`);
                assert.equal(sum, expected.sum, `${bag}/${table} row contents`);
                checks.push({ bag, table, rows: count });
            }
        } finally { db.close(); }
    }
    report.rowChecks = checks;
    console.log(`Preserved all rows across ${checks.length} ordinary tables`);
    // Immutable migration archives retain the captures; release duplicate inputs
    // before making the backup and restored copy on a space-limited machine.
    for (const capture of captures) rmSync(join(home, "app-support", capture.path), { force: true });
    const peers = new NodeRegistry();
    const identities = new DatabaseSync(join(generation, "node/identities/identities.db"), { readOnly: true });
    const identityIds = new Map((identities.prepare("SELECT id FROM identities").all() as { id: number }[]).map(({ id }) => [peers.identityId(id), id]));
    identities.close();
    for (const path of outputs.filter((path) => relative(generation, path).startsWith("identities/"))) {
        const parts = relative(generation, path).split("/");
        const identity = identityIds.get(parts[1]); assert(identity !== undefined);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            for (const table of ordinary(db)) {
                const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
                if (columns.some((column) => column.name === "identity_id")) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${quote(table)} WHERE identity_id IS NULL OR identity_id<>?`).get(identity)?.count, 0, `${path}/${table} ownership`);
            }
        } finally { db.close(); }
    }
    report.ownership = "passed";
    const history = [];
    for (const path of outputs) {
        const parts = relative(generation, path).split("/");
        const bag = parts.at(-2)!, store = parts.at(-1)!.replace(/\.db$/, "");
        const migrationStore = store === "catalog" && bag === "sessions" ? "sessions" : store === "unscoped" && bag === "embeddings" ? "embeddings" : store === "infrastructure" && bag === "actions" ? "actions" : store;
        const bagRoot = join(repo, "bags", ...(bag === "locks" || bag === "tracker" ? ["filesystem", bag] : bag === "logs" ? ["telemetry", "logs"] : [bag]));
        const migrationDirectory = join(bagRoot, "migrations", migrationStore);
        if (bag !== "core" && !existsSync(migrationDirectory)) throw new Error(`No migration catalog for ${bag}/${store}`);
        const db = new DatabaseSync(path);
        try { history.push({ bag, store, ...migrateStore(db, bag === "core" ? coreProvider.migrations : loadSqlMigrations(bagRoot, `migrations/${migrationStore}`), `${bag}/${store}`) }); }
        finally { db.close(); }
        healthy(path);
        if (bag === "sessions" || bag === "memory") {
            const index = new DatabaseSync(path);
            try {
                const table = bag === "sessions" ? "messages_fts" : "memories_fts";
                index.exec(`INSERT INTO ${table}(${table}${bag === "sessions" ? ",rank" : ""}) VALUES('integrity-check'${bag === "sessions" ? ",1" : ""})`);
                if (bag === "memory") assert.equal(index.prepare("SELECT count(*) AS count FROM memories m LEFT JOIN memories_fts f ON f.rowid=m.rowid WHERE f.rowid IS NULL OR f.title<>m.title OR f.body<>m.body").get()?.count, 0, "memory search index mismatch");
            } finally { index.close(); }
        }
    }
    report.history = history;
    const nodeId = peers.id;
    // Closing the registry checkpoints its WAL. Do this before fingerprinting
    // files, otherwise close changes a captured backup checksum.
    peers.close();
    const snapshots: StoreSnapshot[] = [];
    for (const path of outputs) {
        const parts = relative(generation, path).split("/");
        const db = new DatabaseSync(path, { readOnly: true });
        let schemaVersion: number;
        try { schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version); } finally { db.close(); }
        snapshots.push({ path, manifest: { format: 1, node: nodeId, ...(parts[0] === "identities" ? { identity: parts[1] } : {}), bag: parts.at(-2)!, store: parts.at(-1)!.replace(/\.db$/, ""), schemaVersion, revision: sha(path), capturedAt: new Date().toISOString(), bytes: statSync(path).size, checksum: sha(path) } });
    }
    console.log("Creating and verifying backup");
    const backupRoot = join(root, "backups");
    const saved = await createBackup(snapshots, { root: backupRoot });
    for (const entry of saved.stores) await validateSnapshot({ path: join(backupRoot, saved.id, entry.file), manifest: entry.manifest });
    report.backup = { stores: snapshots.length, status: "passed" };
    report.status = "passed";
} catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    console.error(report.error);
} finally {
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`Report: ${root}/report.json`);
}
