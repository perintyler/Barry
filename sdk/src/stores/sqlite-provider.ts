import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { migrateStore, type Migration } from "./migrate.js";
import type { StoreProvider } from "./registry.js";
/** Share the bag writers' SQLite library so probe connections preserve live WAL files. */
export function sqliteProvider(migrations: readonly Migration[]): StoreProvider {
    return {
        migrations,
        open(path, options) {
            const db = new DatabaseSync(path, { readOnly: options.readonly });
            let recorded = 0;
            try {
                db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
                const stamped = Number(db.prepare("PRAGMA user_version").get()?.user_version);
                recorded = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
                    ? Number(db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get()?.version) : 0;
                const schemaVersion = Math.max(stamped, recorded);
                if (schemaVersion > migrations.length) throw new Error(`unsupported store schema ${schemaVersion}; this provider supports ${migrations.length}`);
                if (!options.readonly) {
                    db.exec("PRAGMA journal_mode=WAL;");
                    migrateStore(db, migrations, path);
                }
            } catch (error) {
                db.close();
                throw error;
            }
            return {
                schemaVersion: () => Math.max(recorded, Number((db.prepare("PRAGMA user_version").get() as {
                    user_version: number;
                }).user_version)),
                revision: () => {
                    const directory = mkdtempSync(join(tmpdir(), "barry-revision-"));
                    try {
                        const snapshot = join(directory, "snapshot.db");
                        db.prepare("VACUUM INTO ?").run(snapshot);
                        return createHash("sha256").update(readFileSync(snapshot)).digest("hex");
                    }
                    finally {
                        rmSync(directory, { recursive: true, force: true });
                    }
                },
                snapshot: async (destination) => {
                    const resources = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_resource_requirements'").get();
                    if (resources && db.prepare("SELECT 1 FROM store_resource_requirements LIMIT 1").get())
                        throw new Error("store requires a resource snapshot provider; database-only backup would omit content");
                    db.prepare("VACUUM INTO ?").run(destination);
                },
                close: () => db.close(),
            };
        },
    };
}
