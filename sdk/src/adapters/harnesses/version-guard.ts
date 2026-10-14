/**
 * Refuse observed builds outside the verified compatibility family: major.minor
 * for pre-1.0 and calendar builds, major for stable semantic builds.
 * Missing or unreadable versions remain the doctor's responsibility. Bundled
 * modes do not probe an unrelated PATH binary; unchanged binaries reuse cache.
 * Rationale: docs/decisions/0023-harness-version-compatibility.md.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { barryCacheDir } from "../../services/home.mjs";
import { parseVersion } from "../../services/checks.js";
import type { Adapter, Mode } from "./index.js";

/** A launch refused because its build is outside the verified compatibility family. */
export class HarnessVersionMismatch extends Error {
  constructor(
    message: string,
    readonly adapterId: string,
    readonly binary: string,
    readonly observed: string,
    readonly verifiedOn: string,
  ) {
    super(message);
    this.name = "HarnessVersionMismatch";
  }
}

export interface VersionGuardOptions {
  /** The environment the harness starts in; its PATH picks the binary. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Run the binary and return its stdout, or null when it cannot run. */
  run?: (binary: string, args: readonly string[]) => string | null;
  /** Where read versions are kept between processes. */
  cacheFile?: string;
  /**
   * A `process.platform` value. Typed as a string so the published types name
   * no `NodeJS` global: a browser consumer of the SDK compiles with no Node types.
   */
  platform?: string;
}

type GuardedAdapter = Pick<Adapter, "id" | "requirements">;

/**
 * Throws `HarnessVersionMismatch` when the binary this mode runs is outside
 * its verified compatibility family.
 *
 * The first executable declared path wins, then command on the session’s
 * PATH, just as doctor and preflight resolve it. resolveBinary can name an
 * executable for a different purpose, so it is not used here.
 */
export function requireVerifiedMajor(
  adapter: GuardedAdapter,
  mode: Pick<Mode, "verifiedOn" | "build">,
  options: VersionGuardOptions = {},
): void {
  const env = options.env ?? process.env;
  if ((env.BARRY_HARNESS_VERSION_CHECK ?? process.env.BARRY_HARNESS_VERSION_CHECK) === "off") return;
  // A bundled build is not the binary on PATH, which says nothing about it.
  if (mode.build === "bundled") return;
  if (compatibilityFamily(mode.verifiedOn) === null) return;
  compare(adapter, mode, locate(adapter.requirements.binary.command, env, adapter.requirements.binary.paths), options);
}

function compare(
  adapter: GuardedAdapter,
  mode: Pick<Mode, "verifiedOn">,
  binary: string | null,
  options: VersionGuardOptions,
): void {
  if (!binary) return;
  const observed = versionOf(adapter, binary, options);
  if (!observed || compatibilityFamily(observed) === compatibilityFamily(mode.verifiedOn)) return;

  const install = installCommand(adapter, options.platform ?? process.platform);
  throw new HarnessVersionMismatch(
    `${adapter.id} will not start: ${binary} is ${observed}, but this adapter was verified on ` +
      `${mode.verifiedOn}, and a different ${narrowFamily(mode.verifiedOn) ? "major.minor" : "major"} version is not one it can drive. ` +
      `Install the verified build${install ? ` (${install})` : ""} and make sure it comes first on PATH, ` +
      "or set BARRY_HARNESS_VERSION_CHECK=off to start it anyway.",
    adapter.id,
    binary,
    observed,
    mode.verifiedOn,
  );
}

/** Pre-1.0 and calendar builds pin the minor; stable semantic builds pin the major. */
function narrowFamily(version: string): boolean {
  return majorOf(version) === 0 || /^\D*\d{4}\./.test(version);
}

function compatibilityFamily(version: string): string | null {
  const match = /^\D*(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  if (!narrowFamily(version)) return String(major);
  return match[2] === undefined ? null : `${major}.${Number(match[2])}`;
}

/** The leading number of a version: 2 for 2.0.24, 2026 for 2026.09.23. */
export function majorOf(version: string): number | null {
  const match = /^\D*(\d+)/.exec(version);
  return match ? Number(match[1]) : null;
}

/** The absolute path the session would start, or null when there is none. */
function locate(named: string, env: Readonly<Record<string, string | undefined>>, paths: readonly string[] = []): string | null {
  for (const path of paths) if (executable(path)) return path;
  if (isAbsolute(named)) return executable(named) ? named : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, named);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function versionOf(adapter: GuardedAdapter, binary: string, options: VersionGuardOptions): string | null {
  const { versionArgs } = adapter.requirements.binary;
  let key: string;
  try {
    const real = realpathSync(binary);
    const stat = statSync(real);
    key = [real, stat.mtimeMs, stat.size, ...versionArgs].join("\0");
  } catch {
    return null;
  }

  const cacheFile = options.cacheFile ?? join(barryCacheDir(), "harness-versions.json");
  const cache = readCache(cacheFile);
  if (typeof cache[key] === "string") return cache[key];

  const run = options.run ?? runVersion;
  const output = run(binary, versionArgs);
  const version = output === null ? null : parseVersion(adapter.requirements, output);
  // Only a version is kept: a binary that failed to answer may answer next time.
  if (version) writeCache(cacheFile, { ...cache, [key]: version });
  return version;
}

function runVersion(binary: string, args: readonly string[]): string | null {
  try {
    return execFileSync(binary, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  } catch {
    return null;
  }
}

const caches = new Map<string, Record<string, string>>();

function readCache(file: string): Record<string, string> {
  const held = caches.get(file);
  if (held) return held;
  let parsed: Record<string, string> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, string>;
  } catch {
    // Absent or unreadable: every version is read again, and written back.
  }
  caches.set(file, parsed);
  return parsed;
}

function writeCache(file: string, cache: Record<string, string>): void {
  caches.set(file, cache);
  // A cache: failing to write it costs the next launch a `--version`, nothing more.
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(cache));
    renameSync(temp, file);
  } catch {
    return;
  }
}

function installCommand(adapter: GuardedAdapter, platform: string): string | undefined {
  const { install } = adapter.requirements.binary;
  if (platform === "darwin" && install.darwin) return install.darwin;
  if (platform === "linux" && install.linux) return install.linux;
  return install.fallback;
}
