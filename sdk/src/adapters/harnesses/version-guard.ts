import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { barryCacheDir } from "../../services/home.mjs";
import { parseVersion } from "../../services/checks.js";
import { assessVersion, modeVersions, type VersionAssessment } from "./versions.js";
import type { Adapter, Mode } from "./index.js";

/** A launch refused because the adapter documents this build as incompatible. */
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
  onWarning?: (message: string) => void;
}

type GuardedAdapter = Pick<Adapter, "id" | "requirements">;

/** Read the same executable that doctor/preflight resolve. Bundled modes use their own build. */
export function inspectHarnessVersion(
  adapter: GuardedAdapter, mode: Pick<Mode, "verifiedOn" | "build" | "versions">,
  options: VersionGuardOptions = {},
): VersionAssessment & { binary?: string } {
  if (mode.build === "bundled") return assessVersion(modeVersions(mode), mode.verifiedOn);
  const binary = resolveHarnessBinary(adapter.requirements, options.env ?? process.env);
  return { ...assessVersion(modeVersions(mode), binary ? versionOf(adapter, binary, options) ?? undefined : undefined), ...(binary ? { binary } : {}) };
}
const warned = new Set<string>();
/** Compatibility notices are advisory; only demonstrated incompatibilities refuse launch. */
export function requireCompatibleVersion(
  adapter: GuardedAdapter, mode: Pick<Mode, "verifiedOn" | "build" | "versions">,
  options: VersionGuardOptions = {},
): void {
  const result = inspectHarnessVersion(adapter, mode, options);
  if (result.status === "incompatible") {
    throw new HarnessVersionMismatch(`${adapter.id} will not start: ${result.observedVersion} is incompatible: ${result.reason}. Recommended version: ${result.recommendedVersion}.`, adapter.id, result.binary ?? "bundled", result.observedVersion!, result.recommendedVersion);
  }
  if (result.status === "supported") return;
  const message = `${adapter.id}: ${result.observedVersion ?? "unknown version"} is outside established support; recommended ${result.recommendedVersion}. ${result.reason ?? "Compatibility and guarantees have not been verified on this build."}`;
  if (options.onWarning) options.onWarning(message);
  else if (!warned.has(message)) { warned.add(message); process.emitWarning(message, { code: "BARRY_HARNESS_VERSION" }); }
}
/** First declared executable, otherwise the session PATH. Explicit commands may be absolute. */
export function resolveHarnessBinary(requirements: Adapter["requirements"], env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const override = requirements.binary.overrideEnv && (env[requirements.binary.overrideEnv] ?? process.env[requirements.binary.overrideEnv]);
  return locate(override || requirements.binary.command, env, override ? [] : requirements.binary.paths);
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
    key = [real, stat.ino, stat.ctimeMs, stat.mtimeMs, stat.size, adapter.requirements.binary.versionPattern, ...versionArgs].join("\0");
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

/** Resolve once before replacing HOME or constructing a private engine environment. */
export function resolveHarnessCommand(requirements: Adapter["requirements"], env: Readonly<Record<string, string | undefined>> = process.env): string {
  const command = resolveHarnessBinary(requirements, env);
  if (command) return command;
  const override = requirements.binary.overrideEnv && (env[requirements.binary.overrideEnv] ?? process.env[requirements.binary.overrideEnv]);
  if (override) throw new Error(`Configured ${requirements.binary.overrideEnv} executable is unavailable: ${override}`);
  return requirements.binary.command;
}

/** @deprecated Compatibility no longer follows major-version families. */
export const requireVerifiedMajor = requireCompatibleVersion;
