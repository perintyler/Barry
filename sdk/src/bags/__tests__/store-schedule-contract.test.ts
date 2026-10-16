import { describe, it, expect } from "vitest";
import { parseManifestObject } from "../manifest.js";
describe("store and schedule declarations", () => {
    it("rejects obsolete provider declarations with migration instructions", () => {
        expect(() => parseManifestObject({ name: "old", description: "Old", stores: { data: { scope: "node", driver: "sqlite", entry: "provider.ts" } } })).toThrow(/owned_by.*engine.*migrations/);
    });
    it("qualifies local bound references on schedules", () => {
        const manifest = parseManifestObject({ name: "family", description: "Family", stores: { aggregate: { owned_by: "node", engine: "sqlite", migrations: "./migrations" } }, bounds: { desktop: { description: "Only Desktop", bound: { nodes: { allow: ["desktop"] } } } }, schedules: { compile: { every: "5m", action: "family:compile", bags: ["stores"], bounds: ["desktop"] } } });
        expect(manifest.stores?.aggregate.owned_by).toBe("node");
        expect(manifest.schedules.compile.bags).toEqual(["stores"]);
        expect(manifest.schedules.compile.bounds).toEqual(["family:desktop"]);
        expect(() => parseManifestObject({ name: "bad", description: "Bad", stores: { secrets: { owned_by: "identity", engine: "vault", migrations: "./migrations" } } })).toThrow();
    });
});
