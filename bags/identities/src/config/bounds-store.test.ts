import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIdentitiesDb, getIdentitiesSqlite } from "../store/identities-db.js";
import { Bounds, InvalidBoundError } from "./bounds.js";

/**
 * Round-trip tests for a config module that had no tests at all.
 *
 * It was an easy port — no JSON operators — which is exactly what made it
 * dangerous. Under the old store the driver parsed JSON columns on the way out;
 * under SQLite a JSON column comes back as the TEXT it is, and a bare
 * `as SomeRecord` cast with no parse step lets a caller read `row.json.foo`,
 * get `undefined`, and have TypeScript raise no objection.
 *
 * Each test asserts the SHAPE that comes back, not merely that a row exists.
 * `expect(row).toBeDefined()` passes just as happily on a mangled value.
 *
 * This covered `repos` and `settings` too, until both were deleted as dead.
 * Bounds live in the identities store now, with the traits that carry them.
 */
describe("bounds store round-trips", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "barry-bounds-store-"));
    process.env.BARRY_IDENTITIES_DB = join(dir, "identities.db");
    closeIdentitiesDb();
  });

  afterEach(() => {
    closeIdentitiesDb();
    delete process.env.BARRY_IDENTITIES_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("bounds the schema refuses", () => {
    // Only the egress sandbox can enforce an allowlist; under the guards this
    // was stored, logged as inert at session start, and enforced nothing.
    const inert = { network: { allowDomains: ["example.com"] } };

    it("are not created", async () => {
      await expect(Bounds.create({ name: "inert", bound: inert })).rejects.toBeInstanceOf(InvalidBoundError);
      await expect(Bounds.create({ name: "inert", bound: inert })).rejects.toThrow(/egress sandbox/);
      expect(await Bounds.getByName("inert")).toBeUndefined();
    });

    it("do not replace a stored bound", async () => {
      await Bounds.upsertBound({ name: "kept", bound: { network: { actions: ["write"] } } });
      await expect(Bounds.upsertBound({ name: "kept", bound: inert })).rejects.toBeInstanceOf(InvalidBoundError);
      expect((await Bounds.getByName("kept"))?.bound).toEqual({ network: { actions: ["write"] } });
    });

    it("are accepted once they name the sandbox", async () => {
      const created = await Bounds.create({ name: "sandboxed", bound: { network: { allowDomains: ["example.com"], enforce: "sandbox" } } });
      expect(created.bound.network?.enforce).toBe("sandbox");
    });
  });

  describe("bounds", () => {
    it("returns the bound as an object, not the stored text", async () => {
      const created = await Bounds.create({
        name: "readonly",
        description: "no writes",
        bound: { deniedTools: ["Write", "Edit"] },
      });

      expect(typeof created.bound).toBe("object");
      expect(created.bound.deniedTools).toEqual(["Write", "Edit"]);

      const fetched = await Bounds.getByName("readonly");
      expect(fetched?.bound.deniedTools).toEqual(["Write", "Edit"]);
    });

    it("upsert replaces the bound of an existing name without duplicating it", async () => {
      await Bounds.upsertBound({ name: "net", bound: { deniedTools: ["WebFetch"] } });
      await Bounds.upsertBound({ name: "net", bound: { deniedTools: ["WebSearch"] } });

      const all = (await Bounds.list()).filter((b) => b.name === "net");
      expect(all).toHaveLength(1);
      expect(all[0].bound.deniedTools).toEqual(["WebSearch"]);
    });
  });
});

describe("stored bounds validate on read (step 17)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "barry-bounds-read-"));
    process.env.BARRY_IDENTITIES_DB = join(dir, "identities.db");
    closeIdentitiesDb();
  });
  afterEach(() => {
    closeIdentitiesDb();
    delete process.env.BARRY_IDENTITIES_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  // A row an older schema (or a hand-edit) left behind must refuse on read, not
  // decode into an empty bound that denies nothing and that doctor cannot see.
  it("refuses a row whose stored bound no longer parses through the schema", async () => {
    getIdentitiesSqlite()
      .prepare("INSERT INTO bounds(token, name, description, bound, metadata) VALUES(?,?,?,?,?)")
      .run("tok-drift", "drifted", null, JSON.stringify({ network: { actions: ["writes"] } }), "{}");
    await expect(Bounds.getByName("drifted")).rejects.toBeInstanceOf(InvalidBoundError);
    await expect(Bounds.list()).rejects.toBeInstanceOf(InvalidBoundError);
  });

  it("refuses a row whose stored bound is not valid JSON", async () => {
    getIdentitiesSqlite()
      .prepare("INSERT INTO bounds(token, name, description, bound, metadata) VALUES(?,?,?,?,?)")
      .run("tok-bad", "notjson", null, "{not json", "{}");
    await expect(Bounds.getByName("notjson")).rejects.toBeInstanceOf(InvalidBoundError);
  });
});
