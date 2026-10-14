#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const checksRoot = dirname(fileURLToPath(import.meta.url));
const [repo, task, ...args] = process.argv.slice(2);
if (!repo || !task || !existsSync(join(repo, "workspace-entries.json"))) {
  console.error("Usage: node checks/run.mjs <Barry checkout> <task> [args...]");
  process.exit(2);
}
const repoRoot = resolve(repo);
const tasks = JSON.parse(readFileSync(join(checksRoot, "tasks.json"), "utf8"));
if (!Object.hasOwn(tasks, task)) {
  console.error(`Unknown check task: ${task}`);
  process.exit(2);
}
process.chdir(repoRoot);
const repoRequire = createRequire(join(repoRoot, "package.json"));
for (const [index, step] of tasks[task].entries()) {
  let command = step.command;
  let commandArgs = [...step.args];
  if (command === "node" || command === "tsx") {
    commandArgs = commandArgs.map((arg) => arg.endsWith(".mjs") ? join(checksRoot, arg) : arg);
    if (command === "tsx") commandArgs.unshift("--import", repoRequire.resolve("tsx"));
    command = process.execPath;
  } else if (command === "bash") {
    commandArgs[0] = join(checksRoot, commandArgs[0]);
  }
  if (index === tasks[task].length - 1) commandArgs.push(...args);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, BARRY_REPO: repoRoot },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
