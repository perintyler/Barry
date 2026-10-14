import { spawn } from "child_process";
import { capText } from "@barry-rocks/sdk/tools";

const DEFAULT_OUTPUT_LIMIT = parseInt(process.env.BASH_OUTPUT_LIMIT || "51200", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.BASH_DEFAULT_TIMEOUT || "120000", 10);
const MAX_TIMEOUT_MS = 600000;

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

// Tail truncation: when output overflows, the END is what matters — that is
// where the error and the summary live. (The old version kept the head.)
function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const capped = capText(text, { limit, mode: "tail" });
  return { text: capped.text, truncated: capped.truncated };
}

export async function executeCommand(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    outputLimit?: number;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<BashResult> {
  const startedAtMs = Date.now();
  const timeoutMs = Math.min(options.timeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const outputLimit = options.outputLimit || DEFAULT_OUTPUT_LIMIT;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let hasTimedOut = false;

    const child = spawn("bash", ["-c", command], {
      cwd,
      env: options.env || process.env,
    });

    const timeoutTimer = setTimeout(() => {
      hasTimedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (exitCode: number | null) => {
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startedAtMs;

      const stdoutResult = truncate(stdout, outputLimit);
      const stderrResult = truncate(stderr, outputLimit);

      if (hasTimedOut) {
        stderrResult.text = `Command timed out after ${timeoutMs}ms\n` + stderrResult.text;
      }

      resolve({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        exitCode: hasTimedOut ? 124 : (exitCode ?? 1),
        truncated: stdoutResult.truncated || stderrResult.truncated,
        durationMs,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startedAtMs;

      resolve({
        stdout,
        stderr: err.message,
        exitCode: 1,
        truncated: false,
        durationMs,
      });
    });
  });
}

