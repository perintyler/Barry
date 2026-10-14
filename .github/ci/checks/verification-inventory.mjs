import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const docs = readFileSync(new URL("docs/verification.md", root), "utf8");
const scripts = [
  ...readdirSync(new URL("cli/scripts/", root)).filter(name => /^verify-.*\.ts$/.test(name)).map(name => `cli/scripts/${name}`),
  ...readdirSync(new URL("cli/scripts/acceptance/", root)).filter(name => name.endsWith(".ts")).map(name => `cli/scripts/acceptance/${name}`),
  "bags/workflows/src/load-probe.ts", "bags/workflows/src/network-load-probe.ts", "bags/workflows/browser/runs.spec.ts",
];
const missing = scripts.filter(path => !docs.includes(`](../${path})`));
if (missing.length) {
  console.error(`docs/verification.md is missing verification inventory rows: ${missing.join(", ")}`);
  process.exitCode = 1;
} else console.log(`Verification inventory OK (${scripts.length} scripts/suites).`);
