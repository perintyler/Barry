/**
 * `barry pack` / `unpack` against a real identity directory and a real
 * identities store — the two places a bag list lives.
 *
 * bag.test.ts fakes both, which is how pack shipped writing only the DB row:
 * the fake accepted the write, the command printed success, and on a real
 * machine the next file-to-row sync put the old list back. This asserts on
 * identity.yaml, the store that owns `bags`.
 *
 * This package's vitest config does not pin stores, so this file pins
 * BARRY_HOME and BARRY_IDENTITIES_DB itself, before anything imports them.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hoisted above the imports, so no module bindings here: plain strings only.
// The directory itself is made in beforeAll, before either store is opened.
const scratch = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/pack-identity-file-${process.pid}-${Date.now()}`;
  process.env.BARRY_HOME = `${root}/home`;
  process.env.BARRY_IDENTITIES_DB = `${root}/identities.db`;
  return { root };
});

// Not what's under test: the config store's registration rows. The bags the
// identity packs are registered in the snapshot the identities operation
// checks a newly packed bag against (written in beforeAll).
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(async (name: string) => ({ name, source: { type: "remote", url: "https://example.test/mcp" }, builtin: false })),
  upsertBag: vi.fn(), deleteBag: vi.fn(async () => true), listBags: vi.fn(async () => []),
  writeRegistrySnapshot: vi.fn(async () => "/tmp/snapshot.json"),
}));
import { bagPackCommand, bagUnpackCommand } from "../src/commands/bag.js";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords } from "@barry-rocks/identities-bag";
import { provisionOwner } from "./helpers/identities.js";

// A name no real bag has, so nothing this test does can touch a real bag.
const BAG = "zz-packtest-nonexistent";
const REMOTE = { type: "remote", url: "https://example.test/mcp" };
let dir: string;

/** The registry snapshot: the bags this test packs, remote so nothing loads code. */
function writeSnapshot(extra: Record<string, unknown> = {}): void {
  mkdirSync(join(process.env.BARRY_HOME!, "app-support"), { recursive: true });
  writeFileSync(
    join(process.env.BARRY_HOME!, "app-support", "bags.snapshot.json"),
    JSON.stringify({ generated: new Date().toISOString(), source: "test", bags: { linear: REMOTE, [BAG]: REMOTE, ...extra } }),
  );
}

beforeAll(async () => {
  // Pack and unpack change the identity through `Barry`, as the CLI does.
  Barry.use(identities);
  mkdirSync(scratch.root, { recursive: true });
  // The installation's owner, whom the identity's row belongs to.
  provisionOwner("Pack Tester");
  writeSnapshot();
  // A directory identity as a hand-written one is: found by scanning the
  // identities folder, with no row until something syncs it.
  dir = join(process.env.BARRY_HOME!, "app-support", "identities", "packtester");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.yaml"), "name: packtester\nbags:\n  - linear\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn");
});
afterAll(() => {
  Barry.reset();
  rmSync(scratch.root, { recursive: true, force: true });
});

const packtester = () => identityRecords.find("packtester");
const fileBags = async () => (await packtester()).record.metadata.bags ?? [];
const rowBags = async () => (await identityRecords.row((await packtester()).record.id))?.metadata.bags ?? [];

describe("pack and unpack on a file-backed identity", () => {
  it("pack writes the bag into identity.yaml and the cached row agrees", async () => {
    await bagPackCommand(BAG, { name: "packtester" });
    expect(await fileBags()).toEqual(["linear", BAG]);
    expect(await rowBags()).toEqual(["linear", BAG]);
  });

  // Pack creates the identity-owned stores a bag declares, so a broken
  // migration fails the pack rather than the bag's first tool call.
  it("pack creates and migrates the identity-owned stores the bag declares", async () => {
    const bagDir = join(scratch.root, "storebag");
    mkdirSync(join(bagDir, "migrations"), { recursive: true });
    writeFileSync(
      join(bagDir, "bag.yaml"),
      "name: zz-storebag\ndescription: test\nstores:\n  notes:\n    owned_by: identity\n    engine: sqlite\n    migrations: migrations\n",
    );
    writeFileSync(join(bagDir, "migrations", "001_initial.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n");
    // Packing a local bag checks its build against the registry snapshot.
    writeSnapshot({ "zz-storebag": { type: "local", path: bagDir } });
    const { getBag } = await import("../src/bags/registration.js");
    vi.mocked(getBag).mockResolvedValueOnce({ name: "zz-storebag", source: { type: "local", path: bagDir }, builtin: false });

    await bagPackCommand("zz-storebag", { name: "packtester" });

    const found = readdirSync(process.env.BARRY_HOME!, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(join("zz-storebag", "notes.db")));
    expect(found).toHaveLength(1);
    const db = new DatabaseSync(join(process.env.BARRY_HOME!, found[0]));
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get()).toBeTruthy();
    } finally {
      db.close();
    }
    await bagUnpackCommand("zz-storebag", { name: "packtester" });
  });

  it("unpack removes it from identity.yaml and the cached row agrees", async () => {
    await bagUnpackCommand(BAG, { name: "packtester" });
    expect(await fileBags()).toEqual(["linear"]);
    expect(await rowBags()).toEqual(["linear"]);
  });

  it("refreshed the cached row without falling back to a warning", () => {
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("cached row was not refreshed"));
  });
});
