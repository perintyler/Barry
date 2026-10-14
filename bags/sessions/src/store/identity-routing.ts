import { getSessionsSqlite } from "./sessions-db.js";
import { identityStorePaths, sessionIdentity } from "@barry-rocks/sdk/stores";
import { currentStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { SessionAccessSchema } from "./session-access.js";

function sessionPartitions(input?: unknown, identityId?: number) {
    const partitions = identityStorePaths("sessions", "sessions");
    if (input === undefined && identityId === undefined) return partitions;
    const access = input === undefined ? undefined : SessionAccessSchema.parse(input);
    if (partitions.length === 0) return partitions;
    const nodes = new NodeRegistry();
    try {
        return partitions.filter(entry => {
            try {
                const id = nodes.legacyIdentityId(entry.identity);
                return (identityId === undefined || identityId === id) && (access === undefined || access.identityIds.includes(id));
            }
            catch (error) {
                if (error instanceof Error && error.message === "unknown local identity") return false;
                throw error;
            }
        });
    } finally { nodes.close(); }
}

/** Route physical stores at the owning service boundary, including background callers. */
export function identityRouting<T extends object>(store: T): T {
    return new Proxy(store, {
        get(target, property, receiver) {
            const operation = Reflect.get(target, property, receiver) as unknown;
            if (typeof operation !== "function")
                return operation;
            return async (...args: unknown[]) => {
                const rawName = String(property).replace(/^db(?=[A-Z])/, "");
                const method = rawName[0].toLowerCase() + rawName.slice(1);
                if (currentStoreContext()?.identity)
                    return operation(...args);
                if (["getSessionMessageCounts", "getLatestActivityBySessions", "getRecentToolCallsBySessions", "getFirstUserMessages"].includes(method)) {
                    const results = [await operation(...args)];
                    for (const entry of sessionPartitions(method === "getLatestActivityBySessions" ? args[1] : undefined))
                        results.push(await withStoreContext({ identity: entry.identity }, () => operation(...args)));
                    if (results.every((result) => result instanceof Map))
                        return new Map(results.flatMap((result) => [...result.entries()]));
                    return results.flat();
                }
                if (["getSessionByProviderSessionId", "endProviderSessionByProviderId"].includes(method)) {
                    for (const entry of identityStorePaths("sessions", "sessions")) {
                        const result = await withStoreContext({ identity: entry.identity }, () => operation(...args));
                        if (result)
                            return result;
                    }
                    return operation(...args);
                }
                if (!existsSync(join(barryStoresDir(), "active.json")))
                    return operation(...args);
                const first = args[0];
                const input = first && typeof first === "object" ? first as Record<string, unknown> : undefined;
                // A session named by id, or a row naming its session (a provider
                // session): either way, the store that holds that session.
                const sessionId = typeof first === "string" ? first : typeof input?.session_id === "string" ? input.session_id : typeof input?.id === "string" ? input.id : undefined;
                let identity = sessionId !== undefined ? sessionIdentity(sessionId) : undefined;
                // `identityId` names a provider row's identity, but on listSessions it
                // is a filter: that listing must still read the catalog and merge every
                // partition. Routing the filter to one store dropped the identity's
                // catalog rows from its pages.
                const legacy = input?.identity_id ?? (method === "listSessions" ? undefined : input?.identityId) ?? (method.includes("ByIdentity") && typeof first === "number" ? first : undefined);
                if (!identity && typeof legacy === "number") {
                    const nodes = new NodeRegistry();
                    try {
                        identity = nodes.identityId(legacy);
                    }
                    finally {
                        nodes.close();
                    }
                }
                if (identity)
                    return withStoreContext({ identity }, () => operation(...args));
                if (["listBoundSessions", "listSessions", "getActiveSessions", "searchSessions", "searchMessages", "getSessionStats", "markCrashedSessions", "archiveAllClosedSessions"].includes(method)) {
                    const partitions = sessionPartitions(method === "listSessions" ? input?.access : undefined, method === "listSessions" && typeof input?.identityId === "number" ? input.identityId : undefined);
                    const results = [await operation(...args)];
                    for (const entry of partitions)
                        results.push(await withStoreContext({ identity: entry.identity }, () => operation(...args)));
                    if (results.every(Array.isArray)) {
                        const rows = results.flat() as Record<string, unknown>[];
                        const sortKey = input?.orderBy === "activity" ? "last_message_at" : input?.orderBy === "ended_at" ? "ended_at" : "created_at";
                        // Global pages must use the same nullable key and binary ID tie-break as SQLite.
                        const descending = (a: unknown, b: unknown) => {
                            const left = a === null || a === undefined ? null : String(a);
                            const right = b === null || b === undefined ? null : String(b);
                            return left === right ? 0 : left === null ? 1 : right === null ? -1 : left < right ? 1 : -1;
                        };
                        rows.sort((a, b) => descending(a[sortKey], b[sortKey]) || descending(a.id, b.id));
                        const searchOptions = method === "searchMessages" && args[1] && typeof args[1] === "object" ? args[1] as Record<string, unknown> : undefined;
                        const limit = typeof input?.limit === "number" ? input.limit : method === "listSessions" ? 50 : method === "searchSessions" ? typeof args[1] === "number" ? args[1] : 20 : method === "searchMessages" ? typeof searchOptions?.limit === "number" ? searchOptions.limit : 20 : undefined;
                        return limit ? rows.slice(0, limit) : rows;
                    }
                    if (results.every((value) => typeof value === "number"))
                        return results.reduce((sum, value) => sum + value, 0);
                    if (method === "getSessionStats") {
                        const totals: Record<string, number> = {};
                        for (const result of results)
                            for (const [key, value] of Object.entries(result as Record<string, number>))
                                totals[key] = (totals[key] ?? 0) + value;
                        const directories = new Set<string>();
                        const collect = () => {
                            for (const row of getSessionsSqlite().prepare("SELECT DISTINCT json_extract(metadata,'$.working_directory') AS directory FROM sessions").all() as {
                                directory: string | null;
                            }[])
                                if (row.directory !== null)
                                    directories.add(row.directory);
                        };
                        collect();
                        for (const entry of identityStorePaths("sessions", "sessions"))
                            withStoreContext({ identity: entry.identity }, collect);
                        totals.unique_directories = directories.size;
                        return totals;
                    }
                }
                return operation(...args);
            };
        },
    });
}
