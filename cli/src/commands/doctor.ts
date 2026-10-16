import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barryCacheDir } from "@barry-rocks/sdk/services";
/**
 * `barry doctor [adapter]` — is each agent adapter usable on this machine?
 *
 * The check itself lives in `@barry-rocks/sdk/adapters/models`, and `barry start`
 * runs the SAME function as its preflight. Two implementations of "is codex
 * installed" is how a launch succeeds against a requirement doctor calls
 * broken.
 *
 * Exit code is the NUMBER OF FAILING ADAPTERS rather than 0/1, so a caller can
 * tell "one vendor missing" from "nothing works" without parsing the output.
 *
 * Adapters declare their own requirements, so new adapters bring their own checks.
 */

import { execFileSync } from "child_process";
import { findInstalled, type Adapter, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { checkRequirements, formatChecks, preflightLine, type Check, type HostProbes } from "@barry-rocks/sdk/adapters/models";
import { MODE_IDS } from "@barry-rocks/sdk/ids";

/** What doctor reads of an adapter — the record is enough, so no adapter code has to load. */
export type AdapterUnderTest = Pick<InstalledAdapter, "id" | "aliases" | "requirements" | "modes" | "bag" | "defaultMode">;

/**
 * The real host probes.
 *
 * `which` and the version/login commands are the only places doctor touches
 * the machine. Both swallow a failure into a null/non-zero answer rather than
 * throwing, because "the command failed" is an ANSWER here — it is most of
 * what doctor reports.
 */
export function hostProbes(): HostProbes {
  return {
    which: (command) => {
      try {
        return execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
      } catch {
        return null;
      }
    },
    run: (command, args) => {
      try {
        const stdout = execFileSync(command, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          // A vendor that hangs must not hang doctor. Ten seconds is far past
          // any `--version`, and a timeout surfaces as "could not run".
          timeout: 10_000,
        });
        return { stdout, code: 0 };
      } catch (err) {
        // A non-zero exit is the login check's normal "not logged in" answer,
        // so the output and code are kept rather than discarded.
        const failure = err as { stdout?: Buffer | string; status?: number };
        return {
          stdout: typeof failure.stdout === "string" ? failure.stdout : (failure.stdout?.toString() ?? ""),
          code: failure.status ?? 1,
        };
      }
    },
    platform: process.platform,
    env: process.env,
  };
}

/** Launch-only cache. Login checks and explicit doctor runs always stay live. */
export function cachedHostProbes(probes: HostProbes = hostProbes(), cacheDir = join(barryCacheDir(), "preflight")): HostProbes {
  const paths = new Map<string, { path: string; stamp: string }>();
  const stamp = (path: string) => {
    const file = statSync(path);
    return `${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  };
  return {
    platform: probes.platform,
    env: probes.env,
    which(command) {
      const previous = paths.get(command);
      try { if (previous && stamp(previous.path) === previous.stamp) return previous.path; } catch { /* Re-resolve a missing binary. */ }
      const path = probes.which(command);
      if (path) { try { paths.set(command, { path, stamp: stamp(path) }); } catch { /* Uncacheable probe result. */ } }
      return path;
    },
    run(command, args) {
      if (args.length !== 1 || args[0] !== "--version") return probes.run(command, args);
      const path = paths.get(command)?.path ?? (command.startsWith("/") ? command : probes.which(command));
      if (!path) return probes.run(command, args);
      let fingerprint: string;
      try { fingerprint = stamp(path); } catch { return probes.run(command, args); }
      const file = join(cacheDir, `${createHash("sha256").update(path).digest("hex")}.json`);
      try {
        if (existsSync(file)) {
          const cached = JSON.parse(readFileSync(file, "utf8")) as { path: string; stamp: string; result: { stdout: string; code: number } };
          if (cached.path === path && cached.stamp === fingerprint && typeof cached.result?.stdout === "string" && cached.result.code === 0) return cached.result;
        }
      } catch { /* Missing or corrupt caches use live probes. */ }
      const result = probes.run(path, args);
      if (result?.code === 0) {
        try {
          mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${process.pid}.tmp`;
          writeFileSync(temporary, JSON.stringify({ path, stamp: fingerprint, result }), { mode: 0o600 });
          renameSync(temporary, file);
        } catch { /* A diagnostic cache cannot make a launch fail. */ }
      }
      return result;
    },
  };
}

export interface DoctorOptions {
  /** Check one adapter instead of all of them. */
  only?: string;
}

/**
 * The launch preflight for one adapter.
 *
 * The SAME check `barry adapter doctor` runs, so a launch cannot succeed
 * against a requirement doctor calls broken. Always returns a line — success
 * included — because a silent preflight cannot be told from a skipped one.
 *
 * Never throws: an adapter this build does not ship, or a probe that cannot
 * run, yields no line rather than failing a launch over a diagnostic.
 */
export async function adapterPreflightNotices(
  adapterId: string,
  probes: HostProbes = cachedHostProbes(),
  modeId?: keyof InstalledAdapter["modes"],
): Promise<string[]> {
  try {
    const { adapterStore } = await import("../adapters/installed.js");
    const { adapters } = await adapterStore();
    // Only a recorded adapter: one that was refused is not one a session can use.
    const record = findInstalled(adapters.installed(), adapterId);
    if (!record) return [];
    return [`Preflight ${preflightLine(record.id, checkRequirements(record.requirements, probes, record.modes[modeId ?? record.defaultMode] ?? undefined))}`];
  } catch (err) {
    // A diagnostic that BROKE is not an adapter with nothing to report, and
    // returning [] here made the two identical — the doc comment above says a
    // silent preflight cannot be told from a skipped one, and this was the
    // path that made it silent. Still never throws: a launch must not fail
    // over its own diagnostic, so this reports and returns.
    return [`Preflight could not run for ${adapterId}: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/** The modes this adapter declares that are verified on this platform. */
function modesAvailable(adapter: AdapterUnderTest, platform: NodeJS.Platform): (typeof MODE_IDS)[number][] {
  if (adapter.requirements.platforms && !adapter.requirements.platforms.includes(platform)) return [];
  return MODE_IDS.filter((id) => {
    const mode = adapter.modes[id];
    return mode && (!mode.platforms || mode.platforms.includes(platform));
  });
}

/** A missing binary is the only hard block: an unpinned or logged-out harness still runs. */
function isUsable(checks: readonly Check[]): boolean {
  return checks.find((check) => check.name === "binary")?.status === "ok";
}

/**
 * What stops `barry adapter add` recording an adapter on this machine: its
 * binary is missing. The rest doctor reports without refusing.
 */
export function blockingProblems(adapter: Pick<Adapter, "requirements" | "modes" | "defaultMode">, probes: HostProbes = hostProbes()): string[] {
  const binary = checkRequirements(adapter.requirements, probes, adapter.modes[adapter.defaultMode] ?? undefined).find((check) => check.name === "binary");
  if (!binary || binary.status === "ok") return [];
  return [`${binary.observed}${binary.fix ? ` — ${binary.fix}` : ""}`];
}

/**
 * Check every adapter and print the table.
 *
 * Returns the number that FAILED, which the caller uses as its exit code.
 */
export function runDoctor(
  adapters: readonly AdapterUnderTest[],
  options: DoctorOptions = {},
  probes: HostProbes = hostProbes(),
  write: (line: string) => void = (line) => console.log(line),
): number {
  const named = options.only ? findInstalled(adapters, options.only) : undefined;
  const selected = options.only ? (named ? [named] : []) : adapters;

  if (options.only && selected.length === 0) {
    write(`no adapter named ${options.only}. Known: ${adapters.map((a) => a.id).join(", ")}`);
    // Distinct from "an adapter failed": nothing was checked at all.
    return 1;
  }

  const failing: string[] = [];
  for (const adapter of selected) {
    const checks = checkRequirements(adapter.requirements, probes, adapter.modes[adapter.defaultMode] ?? undefined);
    const [title, ...rest] = formatChecks(adapter.id, checks);
    const fixes = rest.filter((line) => line.startsWith("  fix "));
    const lines = rest.filter((line) => !line.startsWith("  fix "));
    const available = modesAvailable(adapter, probes.platform);
    write(title ?? adapter.id);
    for (const line of lines) write(line);
    for (const id of modesAvailable(adapter, probes.platform)) {
      const mode = adapter.modes[id]!;
      if (id !== adapter.defaultMode) write(`  ${id}: ${preflightLine(adapter.id, checkRequirements(adapter.requirements, probes, mode))}`);
    }
    write(`  ${"modes".padEnd(8)} ${available.join(", ") || "none available on this platform"}`);
    // Declared credentials, read off the manifest — no adapter code loads. A
    // session needs each of these from the identity's env map or this
    // manifest default; the gate refuses with the fix command when neither
    // holds, so doctor shows the declarations the gate will enforce.
    const credentials = adapter.bag?.manifest.credentials as Record<string, { item?: string; field?: string }> | undefined;
    const credNames = Object.keys(credentials ?? {});
    if (credNames.length > 0) {
      write(`  ${"creds".padEnd(8)} ${credNames.map((n) => `${n} ← vault:${credentials![n].item}.${credentials![n].field}`).join(", ")}`);
      write(`  ${"".padEnd(8)} an identity may override any of these with its own definition`);
    }
    for (const line of fixes) write(line);
    write("");
    if (!isUsable(checks) || checks.some(check => check.name === "compatibility" && check.status === "failed")) failing.push(adapter.id);
  }

  // Printed even when everything passed — a silent doctor cannot be told from
  // one whose checks never ran.
  write(
    failing.length === 0
      ? `${selected.length} adapter(s) checked, all usable.`
      : `${selected.length} adapter(s) checked, ${failing.length} unusable: ${failing.join(", ")}`,
  );
  return failing.length;
}
