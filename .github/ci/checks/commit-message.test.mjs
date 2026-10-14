import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { messageProblems } from "./commit-message.mjs";

test("ordinary messages and the exact subject limit pass", () => {
  deepEqual(messageProblems("Fix session storage\n\nPreserve committed writes."), []);
  deepEqual(messageProblems("a".repeat(72)), []);
});
test("empty and overlong subjects are rejected", () => {
  deepEqual(messageProblems("\nDetails"), ["Commit subject must not be empty"]);
  deepEqual(messageProblems("a".repeat(73)), ["Commit subject exceeds 72 characters"]);
});
test("retained editor guidance is rejected without banning ordinary comments", () => {
  deepEqual(messageProblems("Fix storage\n# Please enter the commit message for your changes."), ["Commit message retains generated editor guidance"]);
  deepEqual(messageProblems("Fix storage\n# Explanation authored by the contributor"), []);
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("the hook honors normal Git cleanup and custom comment characters", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-commit-hook-"));
  const checker = resolve(".github/ci/checks/commit-message.mjs");
  try {
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet");
    const file = join(root, "message");
    const run = () => spawnSync(process.execPath, [checker, file], {
      cwd: root, env: { ...process.env, GIT_EDITOR: "editor" }, encoding: "utf8",
    });
    writeFileSync(file, "Fix storage\n\n# Please enter the commit message for your changes.\n");
    deepEqual(run().status, 0);
    git("config", "commit.cleanup", "verbatim");
    deepEqual(run().status, 1);
    git("config", "commit.cleanup", "strip");
    git("config", "core.commentChar", ";");
    writeFileSync(file, "Fix storage\n\n; Please enter the commit message for your changes.\n");
    deepEqual(run().status, 0);
    git("config", "commit.cleanup", "scissors");
    writeFileSync(file, "Fix storage\n\n; ------------------------ >8 ------------------------\n; Please enter the commit message for your changes.\n");
    deepEqual(run().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
