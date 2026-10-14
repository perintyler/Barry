/**
 * Where every service of this instance listens, read at the moment of use.
 *
 * Service management (`barry up`) assigns each service a stable port, then writes
 * this file before it starts anything. Every client asks it by registry name
 * (`lists.web`, `sessions.api`) on every call, so a service moved with
 * `barry service port` is reached at its new address on the very next request,
 * with nothing restarted.
 *
 * Strict on purpose. The older reader (`host/bag-resources.ts`) treats a missing
 * or unreadable file as "nothing registered" and lets callers fall back to a
 * hard-coded port, which is how a sandbox's traffic reached prod's services.
 * Here a missing file, a malformed one, or a name it does not list is an error
 * that says what to run.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { barryAppSupportDir } from "./home.mjs";

export type ServiceKind = "service" | "app" | "container" | "deployment";

/** One entry: how a client reaches a service. */
export interface ServiceEntry {
  bag: string;
  name: string;
  kind: ServiceKind;
  /** `http://127.0.0.1:<port>` for a TCP service, `unix://<path>` for a socket one, or deep-link for an app. Absent for a worker. */
  url?: string;
  /** Readiness path relative to `url`, e.g. "/health". */
  health?: string;
  /** Optional app identity and protocol declarations for kind: "app". */
  id?: string;
  displayName?: string;
  protocolVersion?: number;
  capabilities?: {
    streaming?: boolean;
    gating?: boolean;
    listener?: boolean;
    attachments?: boolean;
  };
  urlSchemes?: string[];
}

export interface ServiceRegistryFile {
  version: 2;
  /** ISO time service management wrote this. */
  generated: string;
  /** Keyed by registry name, `<bag>.<service>`. */
  resources: Record<string, ServiceEntry>;
}

/** Raised for every way the registry can fail to answer. The message says what to do. */
export class ServiceRegistryError extends Error {
  override name = "ServiceRegistryError";
}

/** `<bag>.<service>`, the name every client looks up. */
export function serviceKey(bag: string, service: string): string {
  return `${bag}.${service}`;
}

/** `<app support>/bag-resources.json`. `BARRY_SERVICE_REGISTRY` redirects it for one test. */
export function serviceRegistryPath(): string {
  return process.env.BARRY_SERVICE_REGISTRY || join(barryAppSupportDir(), "bag-resources.json");
}

let cache: { path: string; ino: number; mtimeMs: number; size: number; file: ServiceRegistryFile } | null = null;

/**
 * The registry as service management last wrote it.
 *
 * Re-read whenever the file's inode, mtime or size changes, so the cost of
 * looking an address up on every call is one `stat`. The inode is what catches
 * a rewrite that kept the same size within the same clock tick: every write
 * renames a new file into place.
 */
export function readServiceRegistry(path = serviceRegistryPath()): ServiceRegistryFile {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ServiceRegistryError(
      `no service registry at ${path}. It is written by \`barry up\`, service discovery: ` +
        "start it (or check BARRY_HOME points at the instance you mean).",
    );
  }
  if (
    cache && cache.path === path && cache.ino === stat.ino &&
    cache.mtimeMs === stat.mtimeMs && cache.size === stat.size
  ) {
    return cache.file;
  }
  const file = parseServiceRegistry(readFileSync(path, "utf8"), path);
  cache = { path, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, file };
  return file;
}

/** Validate a registry's text. Exported for tests and for service management's own round-trip check. */
export function parseServiceRegistry(text: string, path = "<registry>"): ServiceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ServiceRegistryError(
      `service registry ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        "Restart `barry up` to rewrite it.",
    );
  }
  const file = parsed as Partial<ServiceRegistryFile> | null;
  if (!file || typeof file !== "object" || file.version !== 2 || !file.resources || typeof file.resources !== "object") {
    throw new ServiceRegistryError(
      `service registry ${path} is not a version 2 registry. It was written by an older Barry; ` +
        "restart `barry up` to rewrite it.",
    );
  }
  return file as ServiceRegistryFile;
}

/** One service's entry. Throws when the registry does not list it. */
export function serviceEntry(key: string, path?: string): ServiceEntry {
  const file = readServiceRegistry(path);
  const entry = file.resources[key];
  if (!entry) {
    throw new ServiceRegistryError(
      `\`${key}\` is not in this instance's service registry (${path ?? serviceRegistryPath()}). ` +
        "Is its bag installed and enabled? `barry service status` lists what is running.",
    );
  }
  return entry;
}

/** Where a service listens, e.g. `http://127.0.0.1:4885`. Throws when it is unknown or serves nothing. */
export function serviceAddress(key: string, path?: string): string {
  const entry = serviceEntry(key, path);
  if (!entry.url) {
    throw new ServiceRegistryError(`\`${key}\` is registered but serves nothing, so it has no address.`);
  }
  return entry.url;
}

/**
 * Replace the registry in one step: write a temp file, then rename over.
 *
 * A reader never sees half a file, because every client reads this on every
 * call and a torn read would look like an empty instance.
 */
export function writeServiceRegistry(file: ServiceRegistryFile, path = serviceRegistryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (err) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temp file never got created; the error below is the one to report.
    }
    throw err;
  }
}

export interface AppRecord extends ServiceEntry {
  kind: "app";
}

/** All registered apps from the service registry. */
export function listApps(path = serviceRegistryPath()): AppRecord[] {
  const file = readServiceRegistry(path);
  return Object.values(file.resources).filter((r): r is AppRecord => r.kind === "app");
}

/** Look up an app by id, name, or <bag>.<name>. Throws when not found. */
export function appEntry(appIdOrName: string, path = serviceRegistryPath()): AppRecord {
  const file = readServiceRegistry(path);
  const entry =
    file.resources[appIdOrName] ??
    Object.values(file.resources).find(
      (r) => r.kind === "app" && (r.id === appIdOrName || r.name === appIdOrName || `${r.bag}.${r.name}` === appIdOrName),
    );
  if (!entry || entry.kind !== "app") {
    throw new ServiceRegistryError(
      `no app named "${appIdOrName}" is registered. \`barry app list\` shows what is installed.`,
    );
  }
  return entry as AppRecord;
}

/** URL or deep link to open a registered app. */
export function getAppUrl(appIdOrName: string, options: { session?: string; path?: string } = {}): string {
  const app = appEntry(appIdOrName, options.path);
  let base = app.url;
  if (!base && app.urlSchemes && app.urlSchemes.length > 0) {
    base = `${app.urlSchemes[0]}://`;
  }
  if (!base) {
    throw new ServiceRegistryError(`app "${appIdOrName}" declares no URL or url-schemes.`);
  }
  if (options.session) {
    const separator = base.includes("?") ? "&" : base.endsWith("/") ? "" : "/";
    return base.startsWith("http")
      ? `${base}${separator}session=${encodeURIComponent(options.session)}`
      : `${base}${separator}${encodeURIComponent(options.session)}`;
  }
  return base;
}
