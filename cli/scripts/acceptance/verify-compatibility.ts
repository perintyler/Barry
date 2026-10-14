/** Prove retained and candidate binaries can reopen snapshot copies; never open live stores. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [oldPath, newPath, reportPath, outputPath] = process.argv.slice(2);
if (![oldPath, newPath, reportPath, outputPath].every(path => path?.startsWith("/"))) throw new Error("usage: verify-compatibility.ts <recovery-checkout> <candidate-checkout> <inventory.json> <absolute-new-output>");
const old = resolve(oldPath), candidate = resolve(newPath), root = resolve(outputPath);
if (existsSync(root)) throw new Error("output must not exist"); mkdirSync(root, { recursive: true, mode: 0o700 });
const sql = (checkout: string) => execFileSync("git", ["-C", checkout, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(file => file.endsWith(".sql")).map(file => `${basename(file)}:${createHash("sha256").update(readFileSync(join(checkout, file))).digest("hex")}`).sort();
assert.deepEqual(sql(old), sql(candidate), "schema catalogs changed; compatibility requires an explicit upgrade/rollback rehearsal");
const inventory = JSON.parse(readFileSync(reportPath, "utf8")) as { databases: Array<{ path: string; snapshot: string }> };
const results: Array<Record<string, unknown>> = [];
const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(path).href);
/**
 * The script that opens a bag's store through one checkout's own code, which
 * migrates it, then reports the copy's integrity and row count. The identities
 * bag is opened through its package root (`owner.current()` reads the store,
 * `store.close()` releases it); a checkout whose bag predates that root opened
 * it through the store module it then exported, which is the only way in for it.
 */
const openers: Record<string, (checkout: string) => string> = {
  identities: checkout => {
    const bagDir = join(checkout, "bags", "identities");
    const root = (JSON.parse(readFileSync(join(bagDir, "package.json"), "utf8")) as { exports?: Record<string, string> }).exports?.["."];
    return root
      ? `const bag = await import(${moduleUrl(join(bagDir, root))}); await bag.owner.current(); bag.store.close();`
      : `const { getIdentitiesSqlite } = await import(${moduleUrl(join(bagDir, "src/store/identities-db.ts"))}); getIdentitiesSqlite().close();`;
  },
  sessions: checkout => `const { getSessionsSqlite } = await import(${moduleUrl(join(checkout, "bags", "sessions", "src/store/sessions-db.ts"))}); getSessionsSqlite().close();`,
};
for (const [bag, filename] of [["identities", "identities.db"], ["sessions", "sessions.db"]]) {
  const database = inventory.databases.filter(db => basename(db.path) === filename && db.path.includes("/stores/generations/")).sort((a, b) => statSync(a.snapshot).size - statSync(b.snapshot).size)[0];
  assert.ok(database, `no current-generation ${bag} snapshot`);
  const copy = join(root, filename); copyFileSync(database.snapshot, copy, constants.COPYFILE_FICLONE);
  const runner = join(root, "open-store.mjs");
  const observations = [];
  for (const checkout of [old, candidate, old]) {
    writeFileSync(runner, `${openers[bag](checkout)} const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(copy)}, { readOnly: true }); console.log(JSON.stringify({check:db.prepare('PRAGMA quick_check').get().quick_check,rows:db.prepare('SELECT COUNT(*) count FROM ${bag}').get().count})); db.close();`, { mode: 0o600 });
    const value = execFileSync(process.execPath, ["--import", pathToFileURL(join(checkout, "node_modules/tsx/dist/loader.mjs")).href, runner], {
      cwd: checkout, env: { PATH: process.env.PATH, HOME: root, BARRY_HOME: root, [`BARRY_${bag.toUpperCase()}_DB`]: copy, BARRY_CONFIG_ALLOW_EMPTY: "1" }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    });
    observations.push(JSON.parse(value.trim()));
  }
  assert.deepEqual(observations[0], observations[1]); assert.deepEqual(observations[1], observations[2]); assert.equal(observations[0].check, "ok");
  results.push({ bag, observations, snapshotSha256: createHash("sha256").update(readFileSync(database.snapshot)).digest("hex") });
}
writeFileSync(join(root, "acceptance.json"), JSON.stringify({ results, unchangedSqlCatalogs: sql(candidate).length, passed: true }, null, 2), { mode: 0o600 });
console.log("PASS unchanged SQL catalogs; retained → candidate → retained binaries reopen snapshot copies with identical row counts and integrity");
