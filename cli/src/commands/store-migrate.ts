import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "@barry-rocks/sdk/internal/stores";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { migrateLegacyStores, activeStoreRoot, type MigrationReport, type LegacyStore } from "@barry-rocks/sdk/internal/stores";
import { bagDataDir, barryStoresDir, barryAppSupportDir } from "@barry-rocks/sdk/services";
import { assertServicesStopped } from "./db-stores.js";

/** `barry store migrate`: split a legacy install's stores into the generation layout. */
export async function storeMigrateCommand(options: { servicesStopped: boolean; id?: string }): Promise<void> {
    await assertServicesStopped();
    console.log(JSON.stringify(await migrateBuiltinStores(options.servicesStopped, options.id), null, 2));
}
/**
 * Split every builtin store of a legacy install into per-node and
 * per-identity stores in a new generation. Originals are archived, never
 * changed or removed.
 */
export async function migrateBuiltinStores(servicesStopped: boolean, id?: string): Promise<MigrationReport & { reportPath: string }> {
    if (!servicesStopped)
        throw new Error("stop Barry before migrating stores");
    if (existsSync(join(barryStoresDir(), "active.json"))) {
        if (id && existsSync(join(barryStoresDir(), "activations", `${id}.json`)))
            return await migrateLegacyStores([], { servicesStopped, id });
        if (!id || readdirSync(activeStoreRoot()).length)
            throw new Error("stores already migrated; use the existing migration report");
    }
    const legacyStoreDir = (bag: string) => bagDataDir(bag);
    const registry = new NodeRegistry(join(barryStoresDir(), "node", "nodes"));
    try {
        const identities: {
            id: number;
        }[] = [];
        const legacyIdentityPath = process.env.BARRY_IDENTITIES_DB || join(legacyStoreDir("identities"), "identities.db");
        if (existsSync(legacyIdentityPath)) {
            const original = new DatabaseSync(legacyIdentityPath, { readOnly: true });
            try {
                for (const row of original.prepare("SELECT id FROM identities").all())
                    identities.push({ id: Number(row.id) });
            }
            finally {
                original.close();
            }
        }
        const identityMap = new Map(identities.map((identity) => [identity.id, registry.identityId(identity.id)]));
        const sessionsPath = join(legacyStoreDir("sessions"), "sessions.db");
        const sessionOwners = new Map<string, string>();
        if (existsSync(sessionsPath)) {
            const db = new DatabaseSync(sessionsPath, { readOnly: true });
            try {
                for (const row of db.prepare("SELECT id,identity_id FROM sessions").all()) {
                    const owner = identityMap.get(Number(row.identity_id));
                    if (owner)
                        sessionOwners.set(String(row.id), owner);
                }
            }
            finally {
                db.close();
            }
        }
        const sources: LegacyStore[] = [];
        const specs = ["sessions", "memory", "todos", "events", "actions", "embeddings", "decisions", "schedules", "identities"];
        const memoryOwners = new Map<string, string>();
        const memoryPath = join(legacyStoreDir("memory"), "memory.db");
        if (existsSync(memoryPath)) {
            const db = new DatabaseSync(memoryPath, { readOnly: true });
            try {
                for (const row of db.prepare("SELECT id,session_id FROM memories").all()) {
                    const owner = sessionOwners.get(String(row.session_id));
                    if (owner)
                        memoryOwners.set(String(row.id), owner);
                }
            }
            finally {
                db.close();
            }
        }
        for (const bag of specs) {
            const path = join(legacyStoreDir(bag), `${bag}.db`);
            if (!existsSync(path))
                continue;
            sources.push({ bag, store: bag, path, ...(bag === "sessions" ? { nodeStore: "catalog", replicateTables: ["agent_adapters", "providers", "models"] } : bag === "actions" ? { nodeStore: "infrastructure" } : bag === "embeddings" ? { nodeStore: "unscoped", replicateTables: ["collections"] } : {}), owner: (table, row) => {
                    if (bag === "identities" || bag === "schedules")
                        return "node";
                    if (bag === "sessions" && ["providers", "models", "engines", "agent_adapters"].includes(table))
                        return "node";
                    if (typeof row.identity_id === "number")
                        return identityMap.get(row.identity_id);
                    if (bag === "sessions" && table === "sessions")
                        return sessionOwners.get(String(row.id));
                    if (typeof row.session_id === "string")
                        return sessionOwners.get(row.session_id);
                    if (typeof row.owner_session_id === "string")
                        return sessionOwners.get(row.owner_session_id);
                    if (bag === "actions" && typeof row.schedule_id === "string")
                        return "node";
                    if (bag === "embeddings" && table === "collections")
                        return "node";
                    if (bag === "embeddings" && table === "vectors" && typeof row.external_id === "string")
                        return sessionOwners.get(row.external_id.split(":")[0]);
                    if (bag === "memory" && table === "memory_tags")
                        return memoryOwners.get(String(row.memory_id));
                    return undefined;
                } });
        }
        for (const [bag, store] of [["nodes", "peers"], ["backups", "configuration"]]) {
            const path = join(barryStoresDir(), "node", bag, `${store}.db`);
            if (existsSync(path))
                sources.push({ bag, store, path, owner: () => "node" });
        }
        for (const [bag, store] of [["locks", "locks"], ["tracker", "file-tracker"], ["telemetry", "metrics"], ["telemetry", "usage"], ["telemetry", "requests"], ["telemetry", "errors"], ["logs", "logs"]]) {
            const path = join(legacyStoreDir(bag), `${store}.db`);
            if (existsSync(path))
                sources.push({ bag, store, path, owner: () => "node" });
        }
        const config = join(barryAppSupportDir(), "config.db");
        if (existsSync(config))
            sources.push({ bag: "core", store: "config", path: config, owner: () => "node" });
        return await migrateLegacyStores(sources, { servicesStopped, id });
    }
    finally {
        registry.close();
    }
}
