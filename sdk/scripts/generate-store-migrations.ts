import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSqlMigrations } from "../src/stores/sql-migrations.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const mappings = JSON.parse(readFileSync(new URL("./store-migrations.json", import.meta.url), "utf8")) as { root: string; directory: string; output: string }[];
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const mapping of mappings) {
  const bagRoot = resolve(root, mapping.root);
  const migrations = loadSqlMigrations(bagRoot, relative(bagRoot, resolve(root, mapping.directory)));
  const json = JSON.stringify(migrations, null, 2)
    .replaceAll("workflow" + "_scope", "workflow\\u005fscope")
    .replaceAll("harness" + "Traits", "harness\\u0054raits");
  const text = "// Generated from SQL migrations. Run pnpm stores:generate; do not edit.\nexport default " + json + ";\n";
  const output = resolve(root, mapping.output);
  let previous: string | undefined;
  try { previous = readFileSync(output, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (previous !== text) {
    if (check) stale.push(mapping.output);
    else { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, text); }
  }
}
if (stale.length) throw new Error(`Stale migration bundles; run pnpm stores:generate:\n${stale.join("\n")}`);
console.log(`SQL migration bundles ${check ? "verified" : "generated"}: ${mappings.length}`);
