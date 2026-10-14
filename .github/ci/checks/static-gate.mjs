import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tasks = JSON.parse(readFileSync("static-gate.json", "utf8"));
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("The local static gate must contain checks");
for (const task of tasks) {
  if (typeof task !== "string" || !Object.hasOwn(scripts, task)) throw new Error(`Unknown static-gate task: ${task}`);
  const result = spawnSync("pnpm", ["run", task], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
