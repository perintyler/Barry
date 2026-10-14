#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
if (listed.status !== 0) process.exit(listed.status ?? 1);

const files = listed.stdout.split("\0").filter(Boolean);

// A credential scan that examined nothing must not report success.
//
// git exiting 0 with empty output is not hypothetical: it is what happens when
// this runs outside a work tree, or in a container that cannot resolve a
// worktree's gitdir. Before this guard the script printed "Credential scan OK."
// and exited 0 in a repo with no tracked files -- and unlike doc-links, which
// at least prints its count, there was NO number in the output, so nothing a
// reader could catch. The worst consequence in the set paired with the weakest
// signal.
//
// Same shape as barry-home.mjs:51 and service-addresses.mjs, which have had this
// check all along; this script and doc-links were the two that did not.
if (files.length === 0) {
  console.error("credential-audit: scanned 0 files — git ls-files returned nothing; run from the repo root.");
  process.exit(1);
}

const patterns = [
  // Requires real key material after the header. A bare
  // "-----BEGIN PRIVATE KEY-----" carries nothing secret and shows up in tests
  // that assert PEM handling; an actual leaked key always has a base64 body.
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?[A-Za-z0-9+/]{40}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
];
const ignored = /(^|\/)(?:pnpm-lock\.yaml|fixtures|snapshots)(\/|$)|\.(?:png|jpe?g|gif|webp|ico)$/i;
const findings = [];

for (const path of files) {
  if (ignored.test(path)) continue;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    if (pattern.test(content)) findings.push(`${path}: matches ${pattern.source}`);
  }
}

if (findings.length) {
  console.error(`Credential scan failed:\n${findings.map((finding) => `- ${finding}`).join("\n")}`);
  process.exit(1);
}

console.log(`Credential scan OK (${files.length} files).`);
