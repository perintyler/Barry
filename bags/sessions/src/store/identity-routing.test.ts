import { describe, it, expect, vi } from "vitest";
import { currentStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";
vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  identityStorePaths: () => [{ identity: "alice", path: "alice.db" }, { identity: "bob", path: "bob.db" }],
  sessionIdentity: (id: string) => id === "alice-session" ? "alice" : undefined,
}));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  NodeRegistry: class {
        identityId(id: number) { return `identity-${id}`; }
        legacyIdentityId(uuid: string) {
            if (uuid === "alice") return 1;
            if (uuid === "bob") return 2;
            throw new Error("unknown local identity");
        }
        close() { }
    },
}));
import { identityRouting } from "./identity-routing.js";
describe("physical identity routing", () => {
    it("does not open ungranted physical partitions when listing scoped sessions", async () => {
        const opened: string[] = [];
        const store = identityRouting({ listSessions: async (_options: { access: { actorId: number; identityIds: number[] } }) => {
            opened.push(currentStoreContext()?.identity ?? "catalog");
            return [];
        } });
        await store.listSessions({ access: { actorId: 7, identityIds: [1] } });
        expect(opened).toEqual(["catalog", "alice"]);
    });
    it("keeps activity enrichment inside the same granted partitions", async () => {
        const opened: string[] = [];
        const store = identityRouting({ getLatestActivityBySessions: async (_ids: string[], _access: { actorId: number; identityIds: number[] }) => {
            opened.push(currentStoreContext()?.identity ?? "catalog");
            return new Map();
        } });
        await store.getLatestActivityBySessions(["owned"], { actorId: 7, identityIds: [1] });
        expect(opened).toEqual(["catalog", "alice"]);
    });
    it("merges activity pages by timestamp with nulls last and binary ID ties", async () => {
        const store = identityRouting({ listSessions: async (_options: { orderBy: string; limit: number }) => {
            const identity = currentStoreContext()?.identity;
            return identity === "alice" ? [{ id: "a", last_message_at: "2026-03-01" }, { id: "z", last_message_at: null }]
                : identity === "bob" ? [{ id: "b", last_message_at: "2026-03-01" }] : [{ id: "old", last_message_at: "2026-02-01" }];
        } });
        expect((await store.listSessions({ orderBy: "activity", limit: 3 })).map(row => row.id)).toEqual(["b", "a", "old"]);
    });
    it("routes first writes and existing session reads without needing a preexisting partition", async () => {
        const store = identityRouting({ createSession: async (_input: {
                identity_id: number;
            }) => currentStoreContext()?.identity, getSession: async (_id: string) => currentStoreContext()?.identity });
        expect(await store.createSession({ identity_id: 7 })).toBe("identity-7");
        expect(await store.getSession("alice-session")).toBe("alice");
        expect(currentStoreContext()).toBeUndefined();
        expect(await withStoreContext({ identity: "explicit" }, () => store.getSession("alice-session"))).toBe("explicit");
    });
    it("writes a row naming its session (a provider session) into the store that holds that session", async () => {
        const store = identityRouting({ createProviderSession: async (_input: { session_id: string; provider_session_id: string }) => currentStoreContext()?.identity });
        expect(await store.createProviderSession({ session_id: "alice-session", provider_session_id: "p" })).toBe("alice");
        expect(await store.createProviderSession({ session_id: "unknown", provider_session_id: "p" })).toBeUndefined();
    });
    it("merges direct and HTTP batch reads and applies a global list limit", async () => {
        const store = identityRouting({ dbGetSessionMessageCounts: async (_ids: string[]) => new Map([[currentStoreContext()?.identity ?? "catalog", 1]]), listSessions: async (_options: {
                limit: number;
            }) => [{ id: currentStoreContext()?.identity ?? "catalog", created_at: currentStoreContext()?.identity === "bob" ? "2026-02-01" : "2026-01-01" }] });
        expect((await store.dbGetSessionMessageCounts([])).size).toBe(3);
        expect(await store.listSessions({ limit: 1 })).toEqual([{ id: "bob", created_at: "2026-02-01" }]);
    });
});
