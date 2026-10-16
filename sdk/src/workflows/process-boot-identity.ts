/** Native boot identity independent of caller timezone and human date rendering. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkflowError } from "./errors.js";

const nativeEnvironment = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
function darwinObservation(environment: NodeJS.ProcessEnv): { raw: string; identity: string } {
  const raw = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4096, env: environment,
  }).trim();
  const match = /^\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(raw);
  const seconds = Number(match?.[1]), microseconds = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds >= 1_000_000) {
    throw new WorkflowError("SupervisionUnsupported", "Native boot identity is unavailable.", 503);
  }
  return { raw, identity: `darwin:boottime:v1:${seconds}:${microseconds}` };
}

export function processBootIdentity(): string {
  if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (process.platform === "darwin") return darwinObservation({ ...nativeEnvironment, TZ: "UTC" }).identity;
  throw new WorkflowError("SupervisionUnsupported", "Unix process supervision is unavailable.", 503);
}

/**
 * Verify retained identities, including legacy Darwin hashes only when an
 * actual current native observation reproduces them. Unknown old timezones
 * require the legacy-owner drain/fencing procedure, never relaxed PID control.
 */
export function isCurrentProcessBootIdentity(retained: string): boolean {
  try {
    if (process.platform !== "darwin") return retained === processBootIdentity();
    const canonical = darwinObservation({ ...nativeEnvironment, TZ: "UTC" });
    if (retained === canonical.identity) return true;
    if (!/^[a-f0-9]{64}$/.test(retained)) return false;
    if (boundFingerprint(canonical.raw) === retained) return true;
    const environments: NodeJS.ProcessEnv[] = [
      ...(process.env.TZ === undefined || process.env.TZ === "UTC" ? [] : [{ ...nativeEnvironment, TZ: process.env.TZ }]),
      nativeEnvironment,
    ];
    for (const environment of environments) {
      const observed = darwinObservation(environment);
      if (observed.identity !== canonical.identity) return false;
      if (boundFingerprint(observed.raw) === retained) return true;
    }
    return false;
  } catch { return false; }
}
