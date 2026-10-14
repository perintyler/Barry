import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
const pin = JSON.parse(read("cli/src/services/node-runtime.json")).version;
const major = Number(pin.split(".")[0]);
const expected = `>=${major}.9 <${major + 1}`;
const checks = [
  [".node-version", read(".node-version").trim() === String(major)],
  ["package.json engines.node", JSON.parse(read("package.json")).engines.node === expected],
  ["README.md prerequisites", read("README.md").includes(`node, major ${major}, at least ${major}.9`)],
  ["cli/docs/services.md", read("cli/docs/services.md").includes(`Node ${major}.9 or newer is required`)],
];
const drift = checks.filter(([, matches]) => !matches).map(([name]) => name);
if (drift.length) {
  console.error(`Node runtime ${pin} disagrees with ${drift.join(", ")}; align these with ${fileURLToPath(new URL("cli/src/services/node-runtime.json", root))} (engines.node: ${expected}).`);
  process.exitCode = 1;
} else console.log(`Node runtime ${pin}: version declarations agree (floor ${major}.9).`);
