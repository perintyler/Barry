// Adapted from the pinned barry-devops checks for the single SDK package.
/**
 * Hosting vendors belong to installation provider bags; exact exceptions must remain live.
 * See docs/decisions/0015-verification-and-socket-invariants.md.
 * Explicit files or --list select scope; otherwise scan tracked current files.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const BANNED = /tailscale|tailnet|caddy|cloudflared|barry\.lan/i;

/** Files this check and its test must name the words to do their job. */
const SELF = new Set([".github/ci/checks/vendor-neutral.mjs"]);

const EXCEPTIONS = [
  {
    file: "sdk/src/bags/manifest.ts",
    strings: ["tailnet"],
    why: "a retired manifest key, rejected by name with a message naming its replacement",
  },
  {
    file: "sdk/src/bags/__tests__/manifest.test.ts",
    strings: ["tailnet"],
    why: "the test that the retired key is rejected",
  },
];

const argv = process.argv.slice(2);
let files;
if (argv[0] === "--list") {
  files = readFileSync(argv[1], "utf8").split("\n").filter(f => !f || existsSync(f)).filter(Boolean);
} else if (argv.length > 0) {
  files = argv;
} else {
  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("plans/") && !SELF.has(f));
}

const violations = [];
const unusedExceptions = [];
let scannedFileCount = 0;

// Only a full scan can say an exception is stale; a planted file in a test is
// not where the exceptions live.
for (const exception of argv.length === 0 ? EXCEPTIONS : []) {
  let text = "";
  try {
    text = readFileSync(exception.file, "utf8");
  } catch {
    // reported below as unused
  }
  for (const allowedString of exception.strings) {
    if (!text.includes(allowedString)) unusedExceptions.push(`${exception.file}: "${allowedString}"`);
  }
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree, or not a file
  }
  if (text.includes("\0")) continue; // binary
  scannedFileCount += 1;
  const allowedStrings = EXCEPTIONS.filter((e) => e.file === file).flatMap((e) => e.strings);
  text.split("\n").forEach((line, i) => {
    let lineWithoutExceptions = line;
    for (const allowedString of allowedStrings) lineWithoutExceptions = lineWithoutExceptions.split(allowedString).join("");
    const match = BANNED.exec(lineWithoutExceptions);
    if (match) violations.push(`${file}:${i + 1}: "${match[0]}" — ${line.trim().slice(0, 120)}`);
  });
}

if (scannedFileCount === 0) {
  console.error("vendor-neutral: scanned ZERO files, so it checked nothing. The file list is wrong, not the repo clean.");
  process.exit(1);
}

if (violations.length > 0 || unusedExceptions.length > 0) {
  if (violations.length > 0) {
    console.error(`vendor-neutral: ${violations.length} mention(s) of a hosting vendor in core:\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      "\nHosting is installation policy (hosting.yaml) carried out by provider bags. Say it in the\n" +
        "policy's words (local, tunnel, provider), or move the vendor detail into its provider bag.",
    );
  }
  if (unusedExceptions.length > 0) {
    console.error(`\nvendor-neutral: ${unusedExceptions.length} exception(s) excuse something that is no longer there:`);
    for (const unusedException of unusedExceptions) console.error(`  ${unusedException}`);
    console.error("Drop them from EXCEPTIONS.");
  }
  process.exit(1);
}

console.log(`vendor-neutral: clean — ${scannedFileCount} files scanned, ${EXCEPTIONS.length} named exceptions still needed.`);
