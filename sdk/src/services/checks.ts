import type { Platform } from "./platform.js";
/**
 * Whether something Barry depends on is usable on this machine.
 *
 * `barry doctor` and the `barry start` preflight both read these, so a launch
 * cannot succeed against a requirement doctor calls broken. Every check reports
 * what it OBSERVED, success included: "codex: ok" cannot be told apart from a
 * probe that silently returned nothing, while the build it found can.
 */
import type { Requirements } from "../adapters/harnesses/index.js";

export interface Check {
  /** A short label for the report line: "binary", "version", "context window". */
  name: string;
  /** `unknown` means not checked, which is different from checked and broken. */
  status: "ok" | "failed" | "unknown";
  observed: string;
  /** Printed for the human to run — never run on their behalf. */
  fix?: string;
}

/** What the checks need from the host, passed in so they can be tested. */
export interface HostProbes {
  /** Absolute path of a command on PATH, or null. */
  which(command: string): string | null;
  run(command: string, args: readonly string[]): { stdout: string; code: number } | null;
  platform: Platform;
}

/** binary, version and pin — in that order, always all three. Credentials are
 * not a host requirement: they are declared per harness bag and enforced by
 * the session gate against the identity's sources. */
export function checkRequirements(requirements: Requirements, probes: HostProbes): Check[] {
  const { binary } = requirements;
  let located: string | null = null;
  for (const path of binary.paths ?? []) {
    located = probes.which(path);
    if (located) break;
  }
  located ??= probes.which(binary.command);
  const binaryCheck: Check = located
    ? { name: "binary", status: "ok", observed: located }
    : {
        name: "binary",
        status: "failed",
        observed: `${binary.command} not found on PATH`,
        ...fixIfAny(installHint(requirements, probes.platform)),
      };

  if (!located) {
    const skipped = (name: string): Check => ({ name, status: "unknown", observed: "not checked (binary missing)" });
    return [binaryCheck, skipped("version"), skipped("pin")];
  }

  const version = readVersion(requirements, probes, located);
  return [binaryCheck, version, comparePin(version, binary.pin.version)];
}

/**
 * The version a binary's output reports, by the requirement's pattern. `null`
 * when the pattern finds nothing — Barry's declaration is out of date, which is
 * not the same as the harness being missing.
 */
export function parseVersion(requirements: Requirements, output: string): string | null {
  return new RegExp(requirements.binary.versionPattern).exec(output)?.[1] ?? null;
}

function readVersion(requirements: Requirements, probes: HostProbes, located: string): Check {
  const { binary } = requirements;
  const output = probes.run(located, binary.versionArgs);
  if (!output) return { name: "version", status: "unknown", observed: "could not run the binary" };
  const version = parseVersion(requirements, output.stdout);
  return version
    ? { name: "version", status: "ok", observed: version }
    : {
        name: "version",
        status: "unknown",
        observed: `could not read a version from: ${output.stdout.trim().slice(0, 60)}`,
      };
}

function comparePin(version: Check, pin: string): Check {
  if (version.status !== "ok") return { name: "pin", status: "unknown", observed: "no observed version to compare" };
  if (version.observed === pin) return { name: "pin", status: "ok", observed: `pinned ${pin}` };
  return {
    name: "pin",
    status: "failed",
    // Both numbers: "mismatch" alone sends the reader to run --version by hand.
    observed: `running ${version.observed}, pinned ${pin} — declared guarantees are unverified on this build`,
    fix: `install ${pin}, or re-verify this adapter's modes against ${version.observed}`,
  };
}

function installHint(requirements: Requirements, platform: Platform): string | undefined {
  const { install } = requirements.binary;
  if (platform === "darwin" && install.darwin) return install.darwin;
  if (platform === "linux" && install.linux) return install.linux;
  return install.fallback;
}

function fixIfAny(fix: string | undefined): { fix?: string } {
  return fix ? { fix } : {};
}

/** One line per check, passes included, then the fixes for what failed. */
export function formatChecks(title: string, checks: readonly Check[]): string[] {
  const mark = (check: Check) => (check.status === "ok" ? "ok" : check.status === "failed" ? "FAILED" : "unknown");
  const lines = [`${title}:`, ...checks.map((check) => `  ${check.name.padEnd(8)} ${mark(check)}  ${check.observed}`)];
  for (const check of checks) {
    if (check.status === "failed" && check.fix) lines.push(`  ${"fix".padEnd(8)} ${check.fix}`);
  }
  return lines;
}

/** The one line `barry start` prints before launching — always a line, success included. */
export function preflightLine(subject: string, checks: readonly Check[]): string {
  const named = (name: string) => checks.find((check) => check.name === name);
  const binary = named("binary");
  if (binary && binary.status !== "ok") {
    return `${subject}: ${binary.observed}${binary.fix ? ` — ${binary.fix}` : ""}`;
  }
  const notes = ["pin"].flatMap((name) => {
    const check = named(name);
    return check?.status === "failed" ? [check.observed] : [];
  });
  const version = named("version")?.observed ?? "";
  return `${subject} ${version}: ${notes.length > 0 ? notes.join("; ") : "ok"}`;
}
