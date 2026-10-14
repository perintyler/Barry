/**
 * The check goes red on a cross-bag call and on core naming a bag, and stays
 * green on a bag opening its own directory. Each case plants files and names
 * them explicitly, so a check that silently scanned nothing would fail too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dirname, "bag-data-dirs.mjs");
const root = mkdtempSync(join(tmpdir(), "bag-data-dirs-"));

/** A file inside a planted bag named `bag` (or outside every bag when null). */
function plant(bag, source) {
  const dir = join(root, bag ?? "core", "src");
  mkdirSync(dir, { recursive: true });
  if (bag) writeFileSync(join(root, bag, "bag.yaml"), `name: ${bag}\n`);
  const file = join(dir, `planted-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  return file;
}

const run = (...files) => spawnSync(process.execPath, [CHECK, ...files], { encoding: "utf8" });

test("a bag opening its own data directory passes", () => {
  const r = run(plant("alpha", `const db = join(bagDataDir("alpha"), "alpha.db");\n`));
  assert.equal(r.status, 0, r.stderr);
});

test("a bag opening another bag's data directory fails", () => {
  const r = run(plant("alpha", `const db = join(bagDataDir("sessions"), "sessions.db");\n`));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /bagDataDir\("sessions"\) from bag "alpha"/);
});

test("core naming a bag fails", () => {
  const r = run(plant(null, `const dir = bagDataDir("vault");\n`));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /from core/);
});

test("finding no call at all fails rather than passing on nothing", () => {
  const r = run(plant("alpha", `export const nothing = 1;\n`));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /found no bagDataDir/);
});


function extension(source) {
  const file = plant("sessions/extensions/search", source);
  writeFileSync(join(root, "sessions/extensions/search/bag.yaml"), "name: search\nextends: sessions\n");
  return file;
}

test("an extension opening its own data directory passes", () => {
  const r = run(extension('const dir = bagDataDir("sessions/search");\n'));
  assert.equal(r.status, 0, r.stderr);
});

test("an extension opening its parent's data directory fails", () => {
  const r = run(extension('const dir = bagDataDir("sessions");\n'));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /from bag "sessions\/search"/);
});
