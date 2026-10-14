import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { getIdentitiesSqlite, closeIdentitiesDb } from "./identities-db.js";
import { Identities } from "./identities.js";
import { DeviceStore } from "./devices.js";
import { loadIdentityFromDirectory, loadOwnedIdentityFromDirectory, resolveForeignKeyId, syncIdentityToDb, syntheticIdFromName, writeIdentityYaml } from "./identity-files.js";
import { resolveSessionIdentity } from "./identity-resolution.js";

const highId = 1_800_000_123;
let directory: string;
let previousHome: string | undefined;
let previousDb: string | undefined;
beforeEach(() => {
  closeIdentitiesDb();
  directory = mkdtempSync(join(tmpdir(), "barry-identity-ownership-"));
  previousHome = process.env.BARRY_HOME;
  previousDb = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_HOME = join(directory, "home");
  process.env.BARRY_IDENTITIES_DB = join(directory, "identities.db");
  getIdentitiesSqlite().prepare("INSERT INTO actors (id, token, type, name) VALUES (1, 'owner-one', 'user', 'one'), (2, 'owner-two', 'user', 'two')").run();
});
afterEach(() => {
  closeIdentitiesDb();
  if (previousHome === undefined) delete process.env.BARRY_HOME; else process.env.BARRY_HOME = previousHome;
  if (previousDb === undefined) delete process.env.BARRY_IDENTITIES_DB; else process.env.BARRY_IDENTITIES_DB = previousDb;
  rmSync(directory, { recursive: true, force: true });
});
function seed(id: number, actorId: number, name: string) {
  getIdentitiesSqlite().prepare("INSERT INTO identities (id, token, actor_id, name, metadata) VALUES (?, ?, ?, ?, '{}')").run(id, `identity-${id}`, actorId, name);
}
function file(name: string, id?: number) {
  const path = join(process.env.BARRY_HOME!, "app-support", "identities", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "identity.yaml"), `name: ${name}\n${id === undefined ? "" : `id: ${id}\n`}traits: []\n`);
  return path;
}

describe("canonical identity ownership", () => {
  it("retains a high pinned key through rename and preserves an existing device grant", async () => {
    seed(highId, 1, "original-name");
    const path = file("renamed-name", highId);
    const devices = new DeviceStore(getIdentitiesSqlite());
    const request = devices.request({ clientName: "Owned fixture", requestedScopes: ["sessions:read"], requestedIdentityIds: [highId] }, "fixture");
    devices.authorize(request.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [highId] });
    const claim = devices.claim(request.pollToken);
    if (claim.status !== "authorized") throw new Error("Expected fixture issuance");
    expect((await syncIdentityToDb(path, { actorId: 1 })).identityId).toBe(highId);
    expect((await Identities.get(highId))?.name).toBe("renamed-name");
    expect((await Identities.list(1)).map(identity => identity.id)).toEqual([highId]);
    expect(parse(readFileSync(join(path, "identity.yaml"), "utf8")).id).toBe(highId);
    expect(devices.verify(claim.deviceToken)?.identityIds).toEqual([highId]);
    expect(await resolveForeignKeyId(loadIdentityFromDirectory(path, { actorId: 1 }), { actorId: 1 })).toBe(highId);
    expect((await loadOwnedIdentityFromDirectory(path, 1))?.id).toBe(highId);
    expect((await resolveSessionIdentity({ actorId: 1, explicitBarryId: highId })).barry.id).toBe(highId);
  });

  it.each([7, highId])("refuses a pinned key owned by another actor without modifying either source (%i)", async id => {
    seed(id, 2, "foreign-owner");
    const path = file("attempted-rename", id);
    const before = readFileSync(join(path, "identity.yaml"), "utf8");
    await expect(syncIdentityToDb(path, { actorId: 1 })).rejects.toThrow("another actor");
    expect(await resolveForeignKeyId(loadIdentityFromDirectory(path, { actorId: 1 }), { actorId: 1 })).toBeNull();
    expect(readFileSync(join(path, "identity.yaml"), "utf8")).toBe(before);
    expect((await Identities.get(id))?.name).toBe("foreign-owner");
    expect(await Identities.list(1)).toEqual([]);
    expect(await loadOwnedIdentityFromDirectory(path, 1)).toBeNull();
    await expect(resolveSessionIdentity({ actorId: 1, explicitBarryId: id })).rejects.toThrow("not found");
    await expect(resolveSessionIdentity({ actorId: 1, explicitBarryName: "attempted-rename" })).rejects.toThrow("not found");
  });

  it.each([8, highId])("refuses a missing declared key instead of adopting a same-name row (%i)", async id => {
    seed(1, 1, "same-name");
    const path = file("same-name", id);
    const before = readFileSync(join(path, "identity.yaml"), "utf8");
    await expect(syncIdentityToDb(path, { actorId: 1 })).rejects.toThrow("pinned row is missing");
    expect(readFileSync(join(path, "identity.yaml"), "utf8")).toBe(before);
    expect((await Identities.get(1))?.metadata).toEqual({});
    expect((await Identities.list(1)).map(identity => identity.id)).toEqual([1]);
    expect(await loadOwnedIdentityFromDirectory(path, 1)).toBeNull();
  });

  it("keeps the shipped identity's file machine-independent: found by name, never pinned", async () => {
    // The base identity is the root of a checkout, with its bags beside it.
    const shipped = join(directory, "builtin");
    mkdirSync(join(shipped, "bags"), { recursive: true });
    const yamlPath = join(shipped, "identity.yaml");
    writeFileSync(yamlPath, "name: barry\nid: 1357913634\ntraits: []\n");
    const before = readFileSync(yamlPath, "utf8");
    const previousBuiltin = process.env.BARRY_BUILTIN_DIR;
    process.env.BARRY_BUILTIN_DIR = join(shipped, "bags");
    try {
      const created = (await syncIdentityToDb(shipped, { actorId: 1 })).identityId;
      expect((await Identities.get(created))?.name).toBe("barry");
      expect((await syncIdentityToDb(shipped, { actorId: 1 })).identityId).toBe(created);
      expect((await Identities.list(1)).map(identity => identity.id)).toEqual([created]);
      expect(readFileSync(yamlPath, "utf8")).toBe(before);
    } finally {
      if (previousBuiltin === undefined) delete process.env.BARRY_BUILTIN_DIR; else process.env.BARRY_BUILTIN_DIR = previousBuiltin;
    }
  });

  it.each([1, 2])("does not treat a generated hash collision as a pin or ownership proof (%i)", async collisionOwner => {
    const name = "unpersisted-identity";
    const hashId = syntheticIdFromName(name);
    seed(hashId, collisionOwner, "unrelated-row");
    const path = file(name);
    const identity = loadIdentityFromDirectory(path, { actorId: 1 });
    expect(identity.id).toBe(hashId);
    const canonical = await resolveForeignKeyId(identity, { actorId: 1 });
    expect(canonical).not.toBeNull();
    expect(canonical).not.toBe(hashId);
    expect((await Identities.get(hashId))?.name).toBe("unrelated-row");
    expect((await Identities.get(canonical!))?.actor_id).toBe(1);
    expect(parse(readFileSync(join(path, "identity.yaml"), "utf8")).id).toBe(canonical);
  });

  it.each([9, highId])("verifies database-only session references in every numeric range (%i)", async id => {
    seed(id, 1, "database-only");
    const record = await Identities.get(id);
    if (!record) throw new Error("Missing fixture identity");
    expect(await resolveForeignKeyId(record, { actorId: 1 })).toBe(id);
    expect(await resolveForeignKeyId(record, { actorId: 2 })).toBeNull();
    expect(await resolveForeignKeyId({ ...record, actor_id: 2 }, { actorId: 2 })).toBeNull();
    expect(await resolveForeignKeyId({ ...record, id: id + 1 }, { actorId: 1 })).toBeNull();
    expect(await resolveForeignKeyId({ ...record, id: NaN }, { actorId: 1 })).toBeNull();
    expect((await resolveSessionIdentity({ actorId: 1, explicitBarryId: id })).barry.id).toBe(id);
  });

  it("never changes a durable pin when its file name changes twice", async () => {
    seed(highId, 1, "first-name");
    const path = file("second-name", highId);
    await syncIdentityToDb(path, { actorId: 1 });
    writeIdentityYaml(path, { name: "third-name" });
    expect((await syncIdentityToDb(path, { actorId: 1 })).identityId).toBe(highId);
    expect((await Identities.get(highId))?.name).toBe("third-name");
    expect((await Identities.list(1)).length).toBe(1);
  });

  it("projects an unpinned file's owned cache ID without rewriting a read", async () => {
    seed(12, 1, "cached-name");
    const path = file("cached-name");
    const before = readFileSync(join(path, "identity.yaml"), "utf8");
    expect((await loadOwnedIdentityFromDirectory(path, 1))?.id).toBe(12);
    expect(await loadOwnedIdentityFromDirectory(path, 1, { expectedId: 13 })).toBeNull();
    expect((await resolveSessionIdentity({ actorId: 1, explicitBarryId: 12 })).barry.id).toBe(12);
    expect(readFileSync(join(path, "identity.yaml"), "utf8")).toBe(before);
  });

  it("refuses a corrupt known file instead of executing its stale cached configuration", async () => {
    seed(13, 1, "broken-file");
    const path = file("broken-file", 13);
    writeFileSync(join(path, "identity.yaml"), "name: [unterminated\n");
    await expect(resolveSessionIdentity({ actorId: 1, explicitBarryId: 13 })).rejects.toThrow("not found");
    await expect(resolveSessionIdentity({ actorId: 1, explicitBarryName: "broken-file" })).rejects.toThrow("not found");
    expect((await Identities.get(13))?.name).toBe("broken-file");
  });
});
