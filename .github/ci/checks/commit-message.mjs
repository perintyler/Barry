import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function messageProblems(message) {
  const subject = message.split(/\r?\n/)[0] ?? "";
  const problems = [];
  if (!subject.trim()) problems.push("Commit subject must not be empty");
  if ([...subject].length > 72) problems.push("Commit subject exceeds 72 characters");
  if (/^[#;!%].*(?:Please enter the commit message|Changes to be committed:|Untracked files:|On branch |Your branch is)/m.test(message)) {
    problems.push("Commit message retains generated editor guidance");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: commit-message.mjs <message-file>");
  const config = (key) => spawnSync("git", ["config", "--get", key], { encoding: "utf8" }).stdout.trim();
  const cleanup = config("commit.cleanup") || (process.env.GIT_EDITOR === ":" ? "whitespace" : "strip");
  const original = readFileSync(file, "utf8");
  let message = original;
  if (cleanup === "strip" || cleanup === "default") {
    const result = spawnSync("git", ["stripspace", "--strip-comments"], { input: original, encoding: "utf8" });
    if (result.status !== 0) throw new Error("Unable to apply Git comment cleanup");
    message = result.stdout;
  } else if (cleanup === "scissors") {
    const marker = config("core.commentChar") || "#";
    message = original.split(`${marker} ------------------------ >8 ------------------------`)[0];
  }
  const problems = messageProblems(message);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
