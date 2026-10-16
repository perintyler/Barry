import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { verifyArtifact, artifactAbi } from "./artifacts.js";
import { ActivityFailure, type Activity, type Json } from "./types.js";
import type { InstalledJob } from "./job-registry.js";

const OUTPUT_LIMIT = 262_144;

/** The line of a crashed job's stderr that says what went wrong, rather than the stack's tail. */
function failureLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /\b(?:Error|ERR_[A-Z_]+)\b/.test(line)) ?? lines.at(-1) ?? "no output"
  );
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
export function jobActivity(
  job: InstalledJob,
  options: { node?: string; env?: NodeJS.ProcessEnv } = {},
): Activity {
  return async (input, task) => {
    if (task.signal.aborted)
      throw new ActivityFailure(`${job.type} was stopped`, "ExecutionCancelled");
    const source = verifyArtifact({
      path: job.main,
      digest: job.contract.digest,
      type: job.type,
      version: "1",
      abi: artifactAbi,
    });
    return new Promise<Json>((resolve, reject) => {
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...options.env,
        BARRY_JOB_KEY: task.idempotencyKey,
        BARRY_JOB_ATTEMPT: String(task.attempt),
      };
      // The trusted bootstrap imports bytes carried over a private descriptor. The
      // registered path is never reopened after verification, even during spawn.
      const bootstrap =
        'const source = process.getBuiltinModule("node:fs").readFileSync(3); await import(`data:text/javascript;base64,${source.toString("base64")}`);';
      const child = spawn(
        options.node ?? process.execPath,
        [...job.flags, "--input-type=module", "--eval", bootstrap],
        { env, stdio: ["pipe", "pipe", "pipe", "pipe"] },
      );
      const sourcePipe = child.stdio[3] as Writable;
      sourcePipe.on("error", () => {});
      sourcePipe.end(source);
      let stdout = "",
        stderr = "",
        outputBytes = 0,
        overflow = false;
      let launchError: Error | undefined;
      const abort = () => {
        child.kill("SIGKILL");
      };
      task.signal.addEventListener("abort", abort, { once: true });
      if (task.signal.aborted) abort();
      child.stdout.on("data", (data: Buffer) => {
        outputBytes += data.length;
        stdout += data.toString();
        if (outputBytes > OUTPUT_LIMIT) {
          overflow = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4096);
      });
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        launchError = error;
      });
      child.once("close", (code, signal) => {
        task.signal.removeEventListener("abort", abort);
        if (launchError) return reject(launchError);
        if (overflow)
          return reject(
            new ActivityFailure(
              `${job.type} wrote more than ${OUTPUT_LIMIT} bytes to stdout`,
              "ResultTooLarge",
            ),
          );
        if (task.signal.aborted) return reject(new Error(`${job.type} was stopped`));
        if (code !== 0)
          return reject(new Error(`${job.type} exited ${code ?? signal}: ${failureLine(stderr)}`));
        if (!job.contract.outputSchema) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()) as Json);
        } catch {
          reject(
            new ActivityFailure(
              `${job.type} declares an output schema but its stdout is not JSON`,
              "InvalidOutput",
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  };
}
