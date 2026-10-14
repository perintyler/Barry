/**
 * Identities.update — the one write path for identity config — and the guard
 * that stops the row writers from being used for a file's fields.
 *
 * Real stores throughout (scratch SQLite + scratch identity directories): the
 * bug this exists for was a write that reached the wrong store and reported
 * success, which only a test that reads both stores back can see.
 */

import { getIdentitiesDir } from "../paths.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const scratch = mkdtempSync(join(tmpdir(), "identity-writes-"));
// Pinned before the stores are imported: each resolves its path from these.
// Unpinned, a fixture name matching a real identity (the developer's "bux")
// resolves to the real directory — see identities-sqlite.test.ts.
process.env.BARRY_HOME = join(scratch, "home");
process.env.BARRY_IDENTITIES_DB = join(scratch, "identities.db");
process.env.BARRY_CONFIG_DB = join(scratch, "config.db");
process.env.BARRY_BAGS_SNAPSHOT = join(scratch, "bags.snapshot.json");

const { Identities, setIdentityMetadataFieldInRow } = await import("./identities.js");
const { closeIdentitiesDb } = await import("./identities-db.js");
const { Users } = await import("./users.js");
const { Bounds } = await import("../config/bounds.js");
const { loadIdentityFromDirectory: realLoadIdentityFromDirectory, syncIdentityToDb, writeIdentityYaml, findIdentityDirectoryById } = await import("./identity-files.js");

let actorId: number;
let counter = 0;

// POL-19: actorId is required. These reads use the suite's own actor.
const loadIdentityFromDirectory = (dir: string, options: { actorId: number } = { actorId }) => realLoadIdentityFromDirectory(dir, options);

beforeAll(async () => {
  actorId = (await Users.create({ name: "Writer", email: "writer@example.test" })).id;
});
afterAll(() => {
  closeIdentitiesDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** A directory-backed identity, synced once so it also has a cached row. */
async function fileIdentity(yaml: string, dotenv?: string) {
  const name = `file-${++counter}`;
  const dir = join(getIdentitiesDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.yaml"), `name: ${name}\n${yaml}`);
  if (dotenv) writeFileSync(join(dir, ".env"), dotenv);
  await syncIdentityToDb(dir, { actorId });
  const row = await Identities.getByName(actorId, name);
  if (!row) throw new Error("fixture row missing");
  return { name, dir, row, yaml: () => parse(readFileSync(join(dir, "identity.yaml"), "utf8")) };
}

describe("Identities.update on a directory-backed identity", () => {
  let id: Awaited<ReturnType<typeof fileIdentity>>;
  beforeEach(async () => { id = await fileIdentity("bags:\n  - linear\n"); });

  it("removes stale credential values from a file identity's database cache", async () => {
    await setIdentityMetadataFieldInRow(id.row.id, "env_file", { API_KEY: "stale-private-fixture" });
    await syncIdentityToDb(id.dir, { actorId });
    const cached = await Identities.getByName(actorId, id.name);
    expect(cached?.metadata).not.toHaveProperty("env_file");
    expect(JSON.stringify(cached?.metadata)).not.toContain("stale-private-fixture");
  });

  it("writes references without internal origins and clears stale cached bindings", async () => {
    await Identities.update(id.row, { secrets: { API_KEY: { reference: { in: "keychain", item: "api" }, directory: id.dir } } });
    expect(id.yaml().secrets).toEqual({ API_KEY: { in: "keychain", item: "api" } });
    expect((await Identities.getByName(actorId, id.name))?.metadata.secrets?.API_KEY.reference).toEqual({ in: "keychain", item: "api" });
    const updated = await Identities.getByName(actorId, id.name);
    if (!updated) throw new Error("identity missing");
    await Identities.update(updated, { secrets: undefined });
    expect(id.yaml().secrets).toBeUndefined();
    expect((await Identities.getByName(actorId, id.name))?.metadata.secrets).toEqual({});
  });

  it("writes identity.yaml, and the cached row agrees", async () => {
    expect(await Identities.update(id.row, { bags: ["linear", "memory"] })).toBe("file");
    expect(id.yaml().bags).toEqual(["linear", "memory"]);
    expect((await Identities.getByName(actorId, id.name))?.metadata.bags).toEqual(["linear", "memory"]);
  });

  it("survives the file-to-row sync that reverted row-only writes", async () => {
    await Identities.update(id.row, { bags: ["linear", "memory"] });
    await syncIdentityToDb(id.dir, { actorId });
    expect((await Identities.getByName(actorId, id.name))?.metadata.bags).toEqual(["linear", "memory"]);
  });

  it("preserves keyed options through pack changes and clears removed configuration", async () => {
    const configured = await fileIdentity("bags:\n  - linear:\n      store:\n        filepath: /data/linear.db\n");
    await Identities.update(configured.row, { bags: ["linear", "memory"] });
    expect(loadIdentityFromDirectory(configured.dir).metadata.bag_configs).toEqual({ linear: { stores: { default: { filepath: "/data/linear.db" } } } });
    await Identities.update(configured.row, { bags: ["memory"] });
    expect((await Identities.get(configured.row.id))?.metadata.bag_configs).toEqual({});
    expect(configured.yaml().bags).toEqual(["memory"]);
  });

  it("writes display_name under the key the loader reads", async () => {
    await Identities.update(id.row, { display_name: "Written" });
    expect(id.yaml().displayName).toBe("Written");
    expect(loadIdentityFromDirectory(id.dir).metadata.display_name).toBe("Written");
  });

  it("writes required bounds by name without copying rules", async () => {
    const named = await Bounds.create({ name: `ro-${counter}`, bound: { deniedTools: ["Write"] } });
    await Identities.update(id.row, { bounds: [named.name] });
    expect(id.yaml().bounds).toEqual([named.name]);
    expect(id.yaml().bound).toBeUndefined();
    await Identities.update(id.row, { bounds: undefined });
    expect(id.yaml().bounds).toEqual([]);
  });
});

// `bags` and `traits` are unioned with the parent's, and `pack` hands the
// writer the RESOLVED list. Written back verbatim, every inherited entry was
// frozen into the child's file, and the parent could no longer change it.
describe("Identities.update on an identity that inherits", () => {
  it("stores only the bags its parent does not already provide", async () => {
    const parent = await fileIdentity("bags:\n  - linear\n  - memory\n");
    const child = await fileIdentity(`inherits: ${parent.name}\nbags:\n  - slack\n`);
    await Identities.update(child.row, { bags: ["linear", "memory", "slack", "github"] });
    expect(child.yaml().bags).toEqual(["slack", "github"]);
    expect(loadIdentityFromDirectory(child.dir).metadata.bags).toEqual(["linear", "memory", "slack", "github"]);
  });

  it("stores only the traits its parent does not already provide", async () => {
    const parent = await fileIdentity("traits:\n  - coding\n");
    const child = await fileIdentity(`inherits: ${parent.name}\n`);
    await Identities.update(child.row, { traits: ["coding", "no-bash"] });
    expect(child.yaml().traits).toEqual(["no-bash"]);
  });

  it("keeps an inherited bag listed when the child configures it", async () => {
    const parent = await fileIdentity("bags:\n  - linear\n");
    const child = await fileIdentity(`inherits: ${parent.name}\n`);
    await Identities.update(child.row, {
      bags: ["linear"],
      bag_configs: { linear: { stores: { default: { filepath: "/data/linear.db" } } } },
    });
    expect(child.yaml().bags).toEqual([{ linear: { store: { filepath: "/data/linear.db" } } }]);
  });
});

describe("syncing a field the yaml dropped", () => {
  // `barry doctor --fix` printed "Repaired ... adapters" while the row
  // kept its model: the sync MERGES, so a key absent from disk was preserved.
  it("removes a file-owned field from the row once the yaml no longer has it", async () => {
    const id = await fileIdentity("adapters: { claude-code: { model: claude-opus-5 } }\n");
    expect(id.row.metadata.adapters?.["claude-code"].model).toBe("claude-opus-5");
    writeFileSync(join(id.dir, "identity.yaml"), `name: ${id.name}\n`);
    await syncIdentityToDb(id.dir, { actorId });
    const row = await Identities.getByName(actorId, id.name);
    expect(row?.metadata).not.toHaveProperty("adapters");
  });

  // Inheritance hands back `vault: undefined` (a vault is never inherited).
  // The row merge stored that as JSON null, and a null vault fails every
  // config read, so the identity's sessions could not be scoped on alternate
  // syncs: the next one removed the key again.
  it("never stores an absent value as null, however many times it syncs", async () => {
    const parent = await fileIdentity("traits:\n  - coding\n");
    const child = await fileIdentity(`inherits: ${parent.name}\n`);
    for (let sync = 0; sync < 3; sync++) {
      await syncIdentityToDb(child.dir, { actorId });
      const row = await Identities.getByName(actorId, child.name);
      expect(row?.metadata).not.toHaveProperty("vault");
      expect(() => Identities.resolveConfig(row!)).not.toThrow();
    }
  });

  it("leaves row keys the file does not own alone", async () => {
    const id = await fileIdentity("adapters: { claude-code: { model: claude-opus-5 } }\n");
    await setIdentityMetadataFieldInRow(id.row.id, "row_only_marker", "kept");
    await syncIdentityToDb(id.dir, { actorId });
    const row = await Identities.getByName(actorId, id.name);
    expect(row?.metadata).toHaveProperty("row_only_marker", "kept");
  });
});

describe("secret reference writes", () => {
  it("keeps unrelated .env plaintext out of identity YAML and the database", async () => {
    const identity = await fileIdentity("secrets:\n  KEPT:\n    in: vault\n    item: KEPT\n    field: password\n", "PLAIN_SECRET=private-fixture\n");
    const secrets = loadIdentityFromDirectory(identity.dir).metadata.secrets!;
    await Identities.update(identity.row, { secrets: { ...secrets, NEW: { reference: { in: "keychain", item: "barry", account: "x" } } } });
    expect(Object.keys(identity.yaml().secrets as object).sort()).toEqual(["KEPT", "NEW"]);
    expect(JSON.stringify(identity.yaml())).not.toContain("private-fixture");
    expect(JSON.stringify((await Identities.get(identity.row.id))?.metadata)).not.toContain("private-fixture");
  });
});

describe("DB-only identities", () => {
  it("write the row, which is their source of truth", async () => {
    const row = await Identities.create({ actor_id: actorId, name: `db-${++counter}`, metadata: { bags: ["linear"] } });
    expect(await Identities.update(row, { bags: ["linear", "memory"] })).toBe("row");
    expect((await Identities.get(row.id))?.metadata.bags).toEqual(["linear", "memory"]);
  });
});

describe("the row writers refuse what identity.yaml owns", () => {
  it("throws for a file-owned field of a directory-backed identity", async () => {
    const id = await fileIdentity("bags:\n  - linear\n");
    await expect(Identities.setMetadataField(id.row.id, "bags", ["memory"])).rejects.toThrow(/identity\.yaml/);
    await expect(Identities.updateMetadata(id.row.id, { env: {} })).rejects.toThrow(/identity\.yaml/);
    expect(id.yaml().bags).toEqual(["linear"]);
  });

  it("allows a field the file does not own, and any field of a DB-only identity", async () => {
    const id = await fileIdentity("");
    await expect(Identities.setMetadataField(id.row.id, "last_session_note", "x")).resolves.toBeUndefined();
    const row = await Identities.create({ actor_id: actorId, name: `db-${++counter}` });
    await expect(Identities.setMetadataField(row.id, "bags", ["memory"])).resolves.toBeUndefined();
  });
});

it("pins a file identity to its durable row so renames preserve resource ownership", async () => {
  const identity = await fileIdentity("traits: []\n");
  expect(loadIdentityFromDirectory(identity.dir, { actorId }).id).toBe(identity.row.id);
  writeIdentityYaml(identity.dir, { name: "renamed-fixture" });
  expect(findIdentityDirectoryById(identity.row.id)).toBe(identity.dir);
  expect((await syncIdentityToDb(identity.dir, { actorId })).identityId).toBe(identity.row.id);
  expect((await Identities.get(identity.row.id))?.name).toBe("renamed-fixture");
});

describe("writing adapter overrides", () => {
  it("removes retired keys without copying a parent's settings", async () => {
    const parent = await fileIdentity("adapters: { claude-code: { default: true, model: opus } }\n");
    const child = await fileIdentity(`inherits: ${parent.name}\ndefault_coding_agent: claude\n`);
    await Identities.update(child.row, { adapters: { "claude-code": { default: true, model: "opus" } } });
    expect(child.yaml()).not.toHaveProperty("adapters");
    expect(child.yaml()).not.toHaveProperty("default_coding_agent");
    expect((await Identities.get(child.row.id))?.metadata.adapters).toEqual(parent.row.metadata.adapters);
    writeIdentityYaml(parent.dir, { adapters: { "claude-code": { default: true, model: "sonnet" } } });
    expect(loadIdentityFromDirectory(child.dir).metadata.adapters?.["claude-code"].model).toBe("sonnet");
  });
  it("writes a child default and clears only the child's block", async () => {
    const parent = await fileIdentity("adapters: { claude-code: { model: opus } }\n");
    const child = await fileIdentity(`inherits: ${parent.name}\n`);
    await Identities.update(child.row, { adapters: { "claude-code": { model: "opus" }, codex: { default: true, mode: "guest" } } });
    expect(child.yaml().adapters).toEqual({ codex: { default: true, mode: "guest" } });
    await Identities.update(child.row, { adapters: undefined });
    expect(child.yaml()).not.toHaveProperty("adapters");
    expect(loadIdentityFromDirectory(child.dir).metadata.adapters).toEqual({ "claude-code": { default: true, model: "opus" } });
  });
  it("scrubs the retired settings from a stale cache row", async () => {
    const identity = await fileIdentity("adapters: { claude-code: { default: true } }\n");
    await setIdentityMetadataFieldInRow(identity.row.id, "default_model", "old");
    await syncIdentityToDb(identity.dir, { actorId });
    expect((await Identities.get(identity.row.id))?.metadata).not.toHaveProperty("default_model");
  });
});
