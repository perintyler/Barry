import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const result = spawnSync("pnpm", ["exec", "changeset", ...args], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (args[0] === "version") {
  const { version } = JSON.parse(readFileSync("cli/package.json", "utf8"));
  writeFileSync("cli/version.json", JSON.stringify({ version }, null, 2) + "\n");
}
