import { assessVersion, modeVersions } from "../adapters/harnesses/versions.js";
import type { Mode } from "../adapters/harnesses/index.js";
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
  status: "ok" | "failed" | "unknown" | "warning";
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
  env?: Readonly<Record<string, string | undefined>>;
}

/** binary, version and pin — in that order, always all three. Credentials are
 * not a host requirement: they are declared per harness bag and enforced by
 * the session gate against the identity's sources. */
export function checkRequirements(requirements: Requirements, probes: HostProbes, mode?: Pick<Mode, "verifiedOn" | "versions" | "build">): Check[] {
  if (mode?.build === "bundled") return [
    { name: "binary", status: "ok", observed: "bundled runtime (PATH CLI is not used)" },
    { name: "version", status: "ok", observed: mode.verifiedOn },
    compatibility({ name: "version", status: "ok", observed: mode.verifiedOn }, mode),
  ];
  const { binary } = requirements;
  const override = binary.overrideEnv && probes.env?.[binary.overrideEnv];
  let located: string | null = null;
  for (const path of override ? [] : binary.paths ?? []) {
    located = probes.which(path);
    if (located) break;
  }
  located ??= probes.which(override || binary.command);
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
    return [binaryCheck, skipped("version"), skipped("compatibility")];
  }

  const version = readVersion(requirements, probes, located);
  const recommendation = binary.recommendedVersion ?? binary.pin?.version;
  return [binaryCheck, version, compatibility(version, mode ?? { verifiedOn: recommendation ?? "unknown" })];
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
  if (!output || output.code !== 0) return { name: "version", status: "unknown", observed: "could not run the binary" };
  const version = parseVersion(requirements, output.stdout);
  return version
    ? { name: "version", status: "ok", observed: version }
    : {
        name: "version",
        status: "unknown",
        observed: `could not read a version from: ${output.stdout.trim().slice(0, 60)}`,
      };
}

function compatibility(version: Check, mode: Pick<Mode, "verifiedOn" | "versions">): Check {
  const result = assessVersion(modeVersions(mode), version.status === "ok" ? version.observed : undefined);
  return {
    name: "compatibility", status: result.status === "supported" ? "ok" : result.status === "incompatible" ? "failed" : result.status === "unknown" ? "unknown" : "warning",
    observed: `${result.observedVersion ?? "unknown version"}; recommended ${result.recommendedVersion}; ${result.status}; guarantees ${result.tested ? "verified" : "unverified"}${result.reason ? ` — ${result.reason}` : ""}`,
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
  const mark = (check: Check) => (check.status === "ok" ? "ok" : check.status === "failed" ? "FAILED" : check.status === "warning" ? "warning" : "unknown");
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
  const notes = ["compatibility"].flatMap((name) => {
    const check = named(name);
    return check && check.status !== "ok" ? [check.observed] : [];
  });
  const version = named("version")?.observed ?? "";
  return `${subject} ${version}: ${notes.length > 0 ? notes.join("; ") : "ok"}`;
}
