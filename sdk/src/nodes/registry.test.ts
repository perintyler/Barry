import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { NodeRegistry, NODE_MIGRATIONS, readInstallationId, readLocalIdentities } from "./registry.js";
import { migrateStore } from "../stores/migrate.js";
const open = (root = mkdtempSync(join(tmpdir(), "barry-nodes-"))) => new NodeRegistry(root);
describe("owner side: invited workers", () => {
    it("issues a prefixed credential that authenticates as the invited worker id, never as anything else", () => {
        const registry = open();
        const { worker, credential } = registry.inviteWorker("mac");
        expect(credential.startsWith("barry_wk_")).toBe(true);
        expect(registry.authenticate(credential)).toBe(worker.id);
        expect(registry.authenticate(credential.slice("barry_wk_".length))).toBeNull();
        expect(registry.authenticate("barry_wk_not-issued")).toBeNull();
        expect(() => registry.inviteWorker("mac")).toThrow(/already exists/);
        expect(registry.workers().map((entry) => entry.name)).toEqual(["mac"]);
        const root = registry.directory;
        registry.close();
        const reopened = open(root);
        expect(reopened.authenticate(credential)).toBe(worker.id);
        reopened.close();
    });
    it("rotates with a grace period and revokes every credential with the worker", () => {
        const registry = open();
        const { worker, credential } = registry.inviteWorker("mac");
        const rotated = registry.rotateCredential(worker.id, 50);
        expect(registry.authenticate(credential)).toBe(worker.id);
        expect(registry.authenticate(rotated.secret)).toBe(worker.id);
        registry.db.prepare("UPDATE credentials SET expiresAt = ? WHERE expiresAt IS NOT NULL").run(Date.now() - 1000);
        expect(registry.authenticate(credential)).toBeNull();
        expect(registry.authenticate(rotated.secret)).toBe(worker.id);
        registry.revokeWorker("mac");
        expect(registry.authenticate(rotated.secret)).toBeNull();
        expect(registry.workers()).toEqual([]);
        registry.close();
    });
});
describe("worker side: joined owners", () => {
    it("stores the owner's address and the credential to call it, refusing itself and plain http", () => {
        const registry = open();
        expect(() => registry.join({ id: registry.id, name: "self", url: "https://self.example", workerId: "w" }, "barry_wk_x")).toThrow(/this installation/);
        expect(() => registry.join({ id: "owner-1", name: "laptop", url: "http://laptop.example", workerId: "w" }, "barry_wk_x")).toThrow(/https/);
        const owner = registry.join({ id: "owner-1", name: "laptop", url: "https://laptop.example:8451/", workerId: "w-1" }, "barry_wk_secret");
        expect(owner.url).toBe("https://laptop.example:8451");
        expect(registry.owners()).toEqual([owner]);
        expect(registry.ownerCredential("owner-1")).toBe("barry_wk_secret");
        registry.leave("laptop");
        expect(registry.owners()).toEqual([]);
        expect(() => registry.ownerCredential("owner-1")).toThrow(/no credential/);
        registry.close();
    });
});
describe("migration 003", () => {
    it("keeps the installation id and identity folder names from a peers.db at version 2", () => {
        const root = mkdtempSync(join(tmpdir(), "barry-nodes-"));
        mkdirSync(root, { recursive: true });
        const legacy = new DatabaseSync(join(root, "peers.db"));
        migrateStore(legacy, NODE_MIGRATIONS.slice(0, 2), "NODE_MIGRATIONS");
        legacy.exec("INSERT INTO settings VALUES('nodeId','installation-1'); INSERT INTO local_identities VALUES(3,'uuid-3'); INSERT INTO peers(id,name,address) VALUES('p','p','https://p'); INSERT INTO credentials VALUES('c','p','h',NULL,NULL);");
        legacy.close();
        const registry = open(root);
        expect(registry.id).toBe("installation-1");
        expect(registry.legacyIdentityId("uuid-3")).toBe(3);
        expect(registry.db.prepare("SELECT count(*) AS n FROM credentials").get()?.n).toBe(0);
        expect(registry.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('peers','identities')").all()).toEqual([]);
        registry.close();
    });
});
describe("read-only installation lookups", () => {
    it("never create peers.db, and read the id and identity mapping once it exists", () => {
        const root = mkdtempSync(join(tmpdir(), "barry-stores-"));
        expect(readInstallationId(root)).toBeUndefined();
        expect(readLocalIdentities(root).size).toBe(0);
        expect(existsSync(join(root, "node", "nodes", "peers.db"))).toBe(false);
        const registry = new NodeRegistry(join(root, "node", "nodes"));
        const uuid = registry.identityId(7);
        registry.close();
        expect(readInstallationId(root)).toBe(registry.id);
        expect(readLocalIdentities(root).get(uuid)).toBe(7);
    });
});
