import { spawn } from "node:child_process";
import { ActivityFailure, type Activity, type Json } from "./types.js";
import type { InstalledJob } from "./job-registry.js";

const OUTPUT_LIMIT = 262_144;

/** The line of a crashed job's stderr that says what went wrong, rather than the stack's tail. */
function failureLine(stderr: string): string {
  const lines = stderr.split("\n").map(line => line.trim()).filter(Boolean);
  return lines.find(line => /\b(?:Error|ERR_[A-Z_]+)\b/.test(line)) ?? lines.at(-1) ?? "no output";
}

/**
 * Run a job the way a worker does: its one file under Node's permission
 * model, with only what its bound grants (the network), the input as JSON on
 * stdin, and — when the job declares an output schema — its result as JSON on
 * stdout. BARRY_JOB_KEY is the step's idempotency key, stable across retries,
 * so a job with an outside effect can make it once.
 *
 * A non-zero exit is an ordinary failure the owner may retry (jobs are
 * at-least-once); output that is not JSON is the job's own mistake and is not
 * retried. The owner checks the output against the pinned contract.
 */
export function jobActivity(job: InstalledJob, options: { node?: string; env?: NodeJS.ProcessEnv } = {}): Activity {
  return (input, task) => new Promise<Json>((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...options.env, BARRY_JOB_KEY: task.idempotencyKey, BARRY_JOB_ATTEMPT: String(task.attempt) };
    const child = spawn(options.node ?? process.execPath, [...job.flags, job.main], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", overflow = false;
    const abort = () => { child.kill("SIGKILL"); };
    task.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); if (stdout.length > OUTPUT_LIMIT) { overflow = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
    child.stdin.on("error", () => {});
    child.on("error", error => { task.signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, signal) => {
      task.signal.removeEventListener("abort", abort);
      if (overflow) return reject(new ActivityFailure(`${job.type} wrote more than ${OUTPUT_LIMIT} bytes to stdout`, "ResultTooLarge"));
      if (task.signal.aborted) return reject(new Error(`${job.type} was stopped`));
      if (code !== 0) return reject(new Error(`${job.type} exited ${code ?? signal}: ${failureLine(stderr)}`));
      if (!job.contract.outputSchema) return resolve(null);
      try { resolve(JSON.parse(stdout.trim()) as Json); }
      catch { reject(new ActivityFailure(`${job.type} declares an output schema but its stdout is not JSON`, "InvalidOutput")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
