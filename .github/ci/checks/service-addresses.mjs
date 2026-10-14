#!/usr/bin/env node
/**
 * Fails where code decides a service's address itself instead of asking the
 * instance's registry at the moment it needs it. Three shapes, in non-test
 * source:
 *
 *   1. A literal loopback address — `http://127.0.0.1:4885`, `localhost:3865`.
 *      A literal port is some instance's port; from any other instance it
 *      reaches the wrong service, and after `barry service port` it reaches
 *      nothing. Find a bag service with `bagServiceUrl()`, a core one with
 *      `getServiceUrl()`.
 *   2. An address captured at module level — `const API = getServiceUrl(...)`
 *      at the top of a file. The lookup is right; doing it once at import is
 *      not, because a moved service is then reached at its old port until the
 *      process restarts. Look it up per call.
 *   3. A service's entry file calling `.listen(` itself. Servers bind through
 *      `listenOnAssignedPort()` (sdk/src/services/listen.ts), which takes
 *      the port the supervisor assigned and binds loopback only; a direct
 *      `.listen(` picks its own port or binds every interface (`hq` did).
 *      Entry files are the scripts Bennu manifests' services run, plus the
 *      engine's; a port probe or a Unix socket elsewhere is not a server.
 *
 * The one thing allowed a literal port is software that is not Barry's:
 * Ollama and Redis, reached through BARRY_OLLAMA_URL and REDIS_URL with their
 * vendors' own defaults.
 *
 * Usage: node checks/service-addresses.mjs [--entry file]... [file...]
 * With files, checks exactly those (how its test plants a violation);
 * without, every tracked source file under sdk, bags, runtime, adapters and checks.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { serviceEntryFiles } from "./service-entry-files.mjs";
import { parse } from "yaml";

const LOOPBACK = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b/g;
const COMMENT = /^\s*(\*|\/\/|\/\*|#)/;
const SOURCE = /\.(ts|mts|mjs|js|cjs|sh|swift)$|(^|\/)(scripts|jobs|bin)\/[^.]+$/;
const SKIP = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/__tests__\/|\/qa\/|\.d\.ts$|vitest\.|\.test-d\.ts$)/;
const CAPTURE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:`[^`]*\$\{)?\s*(getServiceUrl|getServicePort|bagServiceUrl|serviceAddress|getBagResourceUrl)\(/;
const LISTEN = /\.listen\(/;
/** Other software's own ports: Ollama and Redis, never Barry services. */
const VENDOR_PORTS = new Set(["11434", "6379"]);

/** The files the services Bennu manifests declare run, plus the engine's. */
function serviceEntries() {
  const entries = new Set(["runtime/src/mcp/index.ts"]);
  const manifests = execFileSync("git", ["ls-files", "bags/**/bag.yaml", "bags/*/bag.yaml"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const manifest of manifests) {
    const services = parse(readFileSync(manifest, "utf8"))?.services ?? {};
    for (const entry of serviceEntryFiles(manifest, services)) entries.add(entry);
  }
  return entries;
}

const argv = process.argv.slice(2);
const entries = new Set();
const explicit = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--entry") entries.add(argv[++i]);
  else explicit.push(argv[i]);
}
if (explicit.length === 0) for (const e of serviceEntries()) entries.add(e);
const files = explicit.length
  ? explicit
  : execFileSync("git", ["ls-files", "sdk", "cli", "runtime", "bags", "adapters", "ci"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && SOURCE.test(f) && !SKIP.test(f));

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  text.split("\n").forEach((line, i) => {
    if (COMMENT.test(line)) return;
    const at = `${file}:${i + 1}: ${line.trim()}`;
    for (const m of line.matchAll(LOOPBACK)) if (!VENDOR_PORTS.has(m[1])) violations.push(`literal address   ${at}`);
    if (CAPTURE.test(line)) violations.push(`captured at load ${at}`);
    if (entries.has(file) && LISTEN.test(line)) violations.push(`direct .listen(  ${at}`);
  });
}

if (files.length === 0) {
  console.error("service-addresses: scanned 0 files — run from the repo root.");
  process.exit(1);
}
if (violations.length) {
  console.error(`service-addresses: ${violations.length} place(s) decide a service's address themselves:`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "Ask the registry at call time: bagServiceUrl() for a bag service, getServiceUrl() for a core one; " +
      "servers bind with listenOnAssignedPort().",
  );
  process.exit(1);
}
if (explicit.length === 0 && entries.size < 5) {
  console.error(`service-addresses: found only ${entries.size} service entry files in the Bennu manifests; the entry reader is broken.`);
  process.exit(1);
}
console.log(`service-addresses: ${files.length} files clean (${entries.size} service entry files checked for .listen).`);
