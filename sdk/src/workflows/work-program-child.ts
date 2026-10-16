/** Trusted process guardian. It cannot see application bytes or credentials until
 * the parent commits its handle and releases the private input descriptor. */
import { readFileSync, writeFileSync, statSync, mkdirSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workProcessProgramSchema } from "./work-contracts.js";
import { assertProcessProgramDirectory, assertProcessProgramRuntime } from "./work-process-program.js";
import { ProcessGroupGuardian } from "./process-group-guardian.js";

try {
  const request = JSON.parse(readFileSync(3, "utf8")), program = workProcessProgramSchema.parse(request.program);
  if (request.command !== undefined && (!Number.isFinite(request.commandTimeoutMs) || request.commandTimeoutMs <= 0)) {
    throw new Error("Command timeout is unavailable.");
  }
  assertProcessProgramDirectory(program); assertProcessProgramRuntime(program);
  process.chdir(program.cwd.path);
  const actual = statSync(".");
  if (actual.dev !== program.cwd.device || actual.ino !== program.cwd.inode) throw new Error("Working directory changed.");
  const directory = request.directory as string;
  const runtime = program.runtime_path ?? join(directory, "runtime"), sourceDirectory = join(directory, "source");
  if (!program.bundle) mkdirSync(sourceDirectory, { mode: 0o700 });
  const source = join(sourceDirectory, program.bundle?.entry ?? program.source_name);
  try {
    if (!program.bundle && program.argv.some(value => typeof value !== "string")) writeFileSync(source, Buffer.from(request.source, "base64"), { mode: 0o400, flag: "wx" });
    const guardian = new ProcessGroupGuardian({ deadline: request.deadline,
      stopping: () => writeSync(4, '{"stopping":true}\n'),
      timedOut: () => writeSync(4, '{"timed_out":true}\n'),
      escaped: descendants => writeSync(4, `${JSON.stringify({ escaped: descendants })}\n`) });
    // Acknowledge on the private guardian descriptor before the parent sends
    // group TERM. Signal callbacks and child-close callbacks have no ordering
    // guarantee; retaining identity cannot depend on which callback runs first.
    let stopRequest = "";
    process.stdin.on("data", bytes => {
      if (stopRequest.length > 32) return;
      stopRequest += bytes.toString("utf8");
      if (stopRequest.split("\n").includes("stop")) {
        guardian.stop();
      }
    });
    process.stdin.on("end", () => guardian.stop());
    process.stdin.on("error", () => guardian.stop());
    for (const name of program.source_environment ?? []) request.environment[name] = sourceDirectory;
    const args = request.command === undefined ? program.argv.map(value => typeof value === "string" ? value : "source" in value ? source : value.format === "file-url" ? pathToFileURL(join(sourceDirectory, value.file)).href : join(sourceDirectory, value.file)) :
      ["-c", String(request.command).replaceAll("${ACTION_DIR}", sourceDirectory).replaceAll("${CLAUDE_SKILL_ROOT}", sourceDirectory)];
    guardian.beforeLaunch();
    const child = spawn(runtime, args, {
      env: guardian.environment(request.environment), stdio: ["pipe", 1, 2],
    });
    if (request.command !== undefined) child.once("spawn", () => {
      // Parent loss must not widen a shorter check's accepted budget.
      guardian.narrowDeadline(Date.now() + request.commandTimeoutMs);
      try { writeSync(4, '{"started":true}\n'); } catch { guardian.stop(); }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(request.input);
    let spawnFailed = false;
    child.on("error", () => { spawnFailed = true; process.stderr.write("Program could not start.\n"); });
    child.on("close", (code, signal) => {
      guardian.applicationClosed(code, () => {
        if (request.command !== undefined) writeSync(4, JSON.stringify({ code, signal, spawn_failed: spawnFailed }) + "\n");
      });
    });
  } catch { throw new Error("Program preparation failed."); }
} catch { process.stderr.write("Program preparation failed.\n"); process.exit(1); }
