/**
 * Process identity for recovery: is the process that ran an attempt still the
 * same process? A pid alone cannot say — pids are reused — so it is paired
 * with the start time, the way bags/sessions' process-liveness does.
 */

import { execFileSync } from "node:child_process";

/** Start time of `pid` in epoch ms, or null when it cannot be read. */
export function processStartTime(pid: number): number | null {
  try {
    const processStartText = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const startedAtMs = Date.parse(processStartText);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

export type ProcessState = "alive" | "gone" | "unknown";

/**
 * Whether `pid`, started at `recordedStart`, is still running. "unknown" when
 * identity cannot be established — the caller must not treat that as gone,
 * or it would start a second copy of work that may still be running.
 */
export function probeProcess(pid: number, recordedStart: number | null): ProcessState {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code !== "EPERM") return "unknown";
  }
  if (recordedStart == null) return "unknown";
  const currentStartedAtMs = processStartTime(pid);
  if (currentStartedAtMs == null) return "unknown";
  // lstart has one-second resolution; a reused pid starts much later.
  return Math.abs(currentStartedAtMs - recordedStart) < 2000 ? "alive" : "gone";
}

/** TERM a process group, then KILL it after `graceMs`. */
export function killGroup(pgid: number | null, graceMs = 10_000): void {
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, graceMs).unref();
}
