/** Native report-pipe loss fixture; all paths and process identities are task-owned. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessGroupGuardian } from "../process-group-guardian.js";
import { processBootIdentity } from "../work-process-supervisor.js";

const self = fileURLToPath(import.meta.url), loader = import.meta.resolve("tsx");
const root = realpathSync(process.argv[3] ?? "");
assert.equal(dirname(root), realpathSync(tmpdir()));
assert.match(basename(root), /^guardian-report-loss-[A-Za-z0-9]+$/);
function metadata() {
  return { pid: process.pid, pgid: Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1000 }).trim()),
    pidStartedAt: Math.floor(Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1000 }).trim()) / 1000),
    bootIdentity: processBootIdentity(), hostname: hostname() };
}
const mode = process.argv[2];
if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(root, "descendant.json"), JSON.stringify(metadata()));
  setInterval(() => {}, 1000);
} else if (mode === "application") {
  writeFileSync(join(root, "application.json"), JSON.stringify(metadata()));
  const child = spawn(process.execPath, ["--import", loader, self, "descendant", root], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: "ignore",
  });
  child.once("error", () => process.exit(2));
  while (!existsSync(join(root, "descendant.json"))) await new Promise(resolve => setTimeout(resolve, 10));
  const descendant = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8")) as { pid: number };
  assert.equal(descendant.pid, child.pid);
  process.on("message", value => { if (value && typeof value === "object" && "command" in value && value.command === "exit-root") process.exit(0); });
  assert.ok(process.send);
  process.send({ ready: true, application: metadata(), descendant });
  setInterval(() => {}, 1000);
} else if (mode === "guardian") {
  const deadline = Number(process.argv[4]);assert.ok(Number.isSafeInteger(deadline) && deadline > Date.now());
  const guardian = new ProcessGroupGuardian({ deadline, stopping: () => { writeFileSync(join(root, "stopping.json"), JSON.stringify({ at: Date.now() })); } });
  const owned = metadata();assert.equal(owned.pgid, process.pid);
  writeFileSync(join(root, "guardian.json"), JSON.stringify(owned));
  guardian.beforeLaunch();
  const child = spawn(process.execPath, ["--import", loader, self, "application", root], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("error", () => process.exit(2));
  child.on("message", value => {
    if (value && typeof value === "object" && "ready" in value && value.ready === true) {
      assert.ok(process.send);process.send({ ...value, guardian: owned, deadline });
    }
  });
  process.on("message", value => {
    if (value && typeof value === "object" && "command" in value && value.command === "exit-application") child.send({ command: "exit-root" });
  });
  child.once("close", code => guardian.applicationClosed(code, () => {
    try { writeSync(3, JSON.stringify({ code }) + "\n"); }
    catch (error) {
      writeFileSync(join(root, "report-loss.json"), JSON.stringify({ code: (error as NodeJS.ErrnoException).code, at: Date.now() }));
      // The production core must swallow actual verdict-channel loss, keeping
      // its live group ownership and autonomous escalation intact.
      throw error;
    }
  }));
} else throw new Error("Unknown owned guardian fixture mode");
