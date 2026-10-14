import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkPromptInstructions(root) {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (tracked.error || tracked.status !== 0) throw new Error("Cannot enumerate tracked files for prompt-instruction check");
  const role = ["SYS", "TEM:"].join("");
  const stop = ["stop what", "you are doing"].join(" ");
  const failures = [];
  for (const path of tracked.stdout.split("\0").filter(Boolean)) {
    const absolute = resolve(root, path);
    const bytes = lstatSync(absolute).isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (text.toLowerCase().includes(stop)
      || [...text.matchAll(/<!--[\s\S]*?-->/g)].some(match => match[0].toUpperCase().includes(role))) failures.push(path);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkPromptInstructions(resolve(process.argv[2] ?? process.cwd()));
  if (failures.length) {
    console.error(`Prompt-instruction check failed in tracked files: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else console.log("Prompt-instruction check passed.");
}
