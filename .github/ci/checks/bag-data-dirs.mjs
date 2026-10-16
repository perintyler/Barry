#!/usr/bin/env node
/**
 * Fails where code opens another bag's data directory by name.
 *
 * `bagDataDir(bag)` is where a bag keeps its stores. A store is opened only by
 * its owner's code; anyone else goes through that code (its tools, its API),
 * never by path. Reaching into another bag's directory couples you to its file
 * names and its schema, and a store with two writers is a store whose
 * migrations can race. So a literal `bagDataDir("<bag>")` must sit inside the
 * bag named — the one whose nearest `bag.yaml` says `name: <bag>`. Code outside
 * every bag (sdk/, adapters/) names no bag at all; the supervisor passes each
 * service its own directory by variable.
 *
 * Named exceptions are listed here with their reason. Each must still make a
 * cross-bag call, or it fails as an exception that excuses nothing.
 *
 * Usage: node checks/bag-data-dirs.mjs [file...]
 * With files, checks exactly those (how its test plants a violation);
 * without, every tracked source file under sdk, builtin and adapters.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

const CALL = /\bbagDataDir\(\s*["'`]([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)["'`]\s*\)/g;
const SOURCE = /\.(ts|mts|mjs|js|cjs)$/;
const TEST = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/__tests__\/|\.test-d\.ts$)/;

const EXCEPTIONS = new Map([
  [
    "bags/telemetry/src/usage/stores.ts",
    "telemetry's usage report reads other bags' stores read-only, to count what they hold",
  ],
  [
    "bags/sessions/api/src/telemetry.ts",
    "the sessions API records model usage into telemetry's usage.db as it happens",
  ],
  [
    "bags/sessions/api/src/workflow-work-worker.ts",
    "the provisioned sessions worker verifies the shared local workflows artifact root and reads retained work agents read-only from the workflows owner store",
  ],
  [
    "cli/src/commands/work.ts",
    "the CLI operator work submission command stores its local operator delegation issuer ledger under bagDataDir(\"cli\")",
  ],
]);

/** The name in the nearest bag.yaml at or above `file`'s directory, or null outside every bag. */
const ownerCache = new Map();
function owningBag(file) {
  let dir = dirname(resolve(file));
  const visited = [];
  while (true) {
    if (ownerCache.has(dir)) {
      const owner = ownerCache.get(dir);
      for (const d of visited) ownerCache.set(d, owner);
      return owner;
    }
    visited.push(dir);
    const manifest = join(dir, "bag.yaml");
    if (existsSync(manifest)) {
      const bag = parse(readFileSync(manifest, "utf8"));
      const name = bag?.name ?? null;
      for (const d of visited) ownerCache.set(d, name);
      return name;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const d of visited) ownerCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

const explicit = process.argv.slice(2);
const files = explicit.length
  ? explicit
  : execFileSync("git", ["ls-files", "sdk", "cli", "bags", "adapters"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && SOURCE.test(f) && !TEST.test(f));

const violations = [];
const excused = new Set();
let calls = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(CALL)) {
      calls += 1;
      const named = match[1];
      const owner = owningBag(file);
      if (owner === named) continue;
      if (EXCEPTIONS.has(file)) {
        excused.add(file);
        continue;
      }
      const where = owner ? `bag "${owner}"` : "core, which is no bag";
      violations.push(`${file}:${i + 1}: bagDataDir("${named}") from ${where}`);
    }
  });
}

const problems = [];
if (calls === 0) {
  problems.push("found no bagDataDir(\"<bag>\") call at all, so the pattern no longer matches how bags open their stores");
}
if (explicit.length === 0) {
  for (const [file, why] of EXCEPTIONS) {
    if (!excused.has(file)) problems.push(`the exception for ${file} (${why}) excuses nothing: it makes no cross-bag call any more. Drop it.`);
  }
}

if (violations.length > 0 || problems.length > 0) {
  if (violations.length > 0) {
    console.error(`bag-data-dirs: ${violations.length} call(s) open another bag's data directory:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error("\nA store is opened only by its owner's code. Go through that bag's tools or API instead.");
  }
  for (const p of problems) console.error(`bag-data-dirs: ${p}`);
  process.exit(1);
}

console.log(`bag-data-dirs: clean — ${calls} bagDataDir calls in ${files.length} files, each from its own bag or a named exception.`);
