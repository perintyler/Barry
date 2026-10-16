/**
 * Identities created outside the well-known directory are recorded in the instance's identities.yaml
 * and must stay discoverable — a Barry the listing cannot see is unreachable by
 * `switch`, the API and My Identities alike.
 */

import { getIdentitiesDir } from "../paths.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createIdentityDirectory,
  listIdentityDirectories as realListIdentityDirectories,
  listIdentityDirectoryPaths,
  findIdentityDirectoryById,
  readIdentitiesRegistry,
  registerIdentityDirectory,
  syntheticIdFromName,
  syncMetadataPayload,
} from "./identity-files.js";

// POL-19: listIdentityDirectories now requires an actorId; this listing test
// does not depend on which actor it names.
const listIdentityDirectories = (options: { actorId: number } = { actorId: 1 }) => realListIdentityDirectories(options);

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.BARRY_HOME;
  home = mkdtempSync(join(tmpdir(), "barry-registry-"));
  process.env.BARRY_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

/** A Barry directory somewhere other than ~/.barry/identities. */
function externalBarry(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "barry-external-")), `barry-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "barry.yaml"), `name: ${name}\n`, "utf-8");
  return dir;
}

describe("identities registry", () => {
  it("is empty when no registry file exists", () => {
    expect(readIdentitiesRegistry()).toEqual({});
    expect(listIdentityDirectoryPaths({ includeBuiltin: false })).toEqual([]);
  });

  it("discovers a Barry registered outside the well-known directory", () => {
    const dir = externalBarry("outside");
    registerIdentityDirectory("outside", dir);

    expect(listIdentityDirectoryPaths()).toContain(dir);
    expect(listIdentityDirectories().map((b) => b.name)).toContain("outside");
  });

  it("resolves a registered Barry by its synthetic id", () => {
    const dir = externalBarry("byid");
    registerIdentityDirectory("byid", dir);

    expect(findIdentityDirectoryById(syntheticIdFromName("byid"))).toBe(dir);
  });

  it("skips a registered path that no longer exists", () => {
    const dir = externalBarry("gone");
    registerIdentityDirectory("gone", dir);
    registerIdentityDirectory("missing", join(tmpdir(), "barry-does-not-exist"));

    // One stale entry must not blank the rest of the listing.
    const names = listIdentityDirectories().map((b) => b.name);
    expect(names).toContain("gone");
    expect(names).not.toContain("missing");
  });

  it("does not list a Barry twice when its registry entry points at the well-known directory", () => {
    createIdentityDirectory("dupe", {});
    const wellKnown = join(getIdentitiesDir(), "dupe");
    registerIdentityDirectory("dupe", wellKnown);

    expect(listIdentityDirectoryPaths().filter((d) => d === wellKnown)).toHaveLength(1);
  });

  it("registers a Barry created at an explicit directory, but not one in the well-known root", () => {
    const target = join(mkdtempSync(join(tmpdir(), "barry-explicit-")), "barry-custom");
    createIdentityDirectory("custom", {}, { dir: target });
    createIdentityDirectory("standard", {});

    const registry = readIdentitiesRegistry();
    expect(Object.keys(registry)).toEqual(["custom"]);
    // Scanning already finds it, so recording it would be redundant state.
    expect(registry.standard).toBeUndefined();
  });
});

describe("syncMetadataPayload — disk→DB mirror can clear bags and bounds", () => {
  it("pins absent bags/bounds to explicit empty arrays so the JSON merge clears them", () => {
    // The loader omits empty arrays entirely; a merge-update with the key
    // absent would keep the stale row value forever.
    const payload = syncMetadataPayload({});
    expect(payload.bags).toEqual([]);
    expect(payload.bounds).toEqual([]);
  });

  it("passes populated bags and bounds through untouched", () => {
    const payload = syncMetadataPayload({ bags: ["bdiff"], bounds: ["readonly"] });
    expect(payload.bags).toEqual(["bdiff"]);
    expect(payload.bounds).toEqual(["readonly"]);
  });
});
