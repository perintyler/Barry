import { resolveLaunch, resolveLaunchdItem } from "@barry-rocks/sdk/internal/services";
/**
 * What service management runs: every service of every enabled bag, plus the MCP
 * engine, each resolved to a command, a directory and the env it declared.
 *
 * Built from the same loader everything else uses, so bag discovery, access
 * levels and `~` expansion behave here exactly as they do at runtime.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Bag, BagRegistry } from "@barry-rocks/sdk/bags";

import { serviceKey } from "@barry-rocks/sdk/services";

/** One process service management keeps running. */
export interface ServiceSpec {
  secrets?: string[];
  /** Left unset when undeclared or absent, rather than failing the start. */
  optionalSecrets?: string[];
  /** Registry name, `<bag>.<service>`. */
  key: string;
  bag: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  cwd: string;
  /** The declared env, before resolution. Resolved at every start, so a moved dependency is picked up. */
  env: import("@barry-rocks/sdk/internal/services").LiteralEnvValue[];
  /** `http` when it listens on an assigned port (or its socket). */
  serves?: "http";
  /** Absolute socket path, for a service that listens on one instead of a port. */
  socket?: string;
  health?: string;
  autostart: "login" | "manual";
  localOnly: boolean;
  /** Registry names whose address this service's env injects. They restart it when they move. */
  injects: string[];
  entry?: string;
  user?: string;
  shutdownMs?: number;
}

export interface SpecProblem {
  key: string;
  message: string;
}

/** The commit the checkout at `root` has out, or undefined when it is not a git checkout. */
export function checkoutCommit(root: string): string | undefined {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A local bag's directory, or null for a remote one. */
function bagDirectory(registry: BagRegistry, name: string): string | null {
  const source = registry[name];
  if (!source || source.type !== "local") return null;
  return resolve(source.path.replace(/^~/, homedir()));
}

/** Every service the enabled bags declare, resolved, plus what could not be. */
export function buildServiceSpecs(bags: Bag[], registry: BagRegistry, stateDirectory: (bag: string, key: string) => string = (_bag, _key) => { throw new Error("system service state directory is required"); }): { specs: ServiceSpec[]; problems: SpecProblem[] } {
  const specs: ServiceSpec[] = [];
  const problems: SpecProblem[] = [];

  for (const bag of bags) {
    const dir = bagDirectory(registry, bag.name);
    if (!dir) continue;
    for (const service of bag.services ?? []) {
      const key = serviceKey(bag.name, service.name);
      if (service.user && (!service.entry || !/\.(?:js|mjs|cjs)$/.test(service.entry))) {
        problems.push({ key, message: "a user: service must declare a built JavaScript entry (.js, .mjs or .cjs)" });
        continue;
      }
      let launch: ReturnType<typeof resolveLaunch>;
      try {
        launch = resolveLaunch(service, dir);
      } catch (error) {
        problems.push({ key, message: `could not resolve launch: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const { item, escaped } = resolveLaunchdItem(dir, {
        name: service.name,
        args: launch.args,
        workingDirectory: service.workingDirectory,
      });
      if (!item) {
        problems.push({ key, message: `${escaped.map((p) => `"${p}"`).join(", ")} escapes the bag directory` });
        continue;
      }
      const command = launch.command;
      const args = item.args ?? [];
      const injects: string[] = [];
      specs.push({
        key,
        bag: bag.name,
        name: service.name,
        description: service.description,
        command,
        args,
        cwd: item.workingDirectory ?? dir,
        ...(service.entry ? { entry: resolve(dir, service.entry) } : {}),
        env: service.env ?? [],
        secrets: service.secrets,
        ...(service.optionalSecrets?.length ? { optionalSecrets: service.optionalSecrets } : {}),
        ...(service.serves ? { serves: "http" as const } : {}),
        ...(service.socket ? { socket: resolve(service.user ? stateDirectory(bag.name, key) : dir, service.socket) } : {}),
        ...(service.health ? { health: service.health } : {}),
        autostart: service.autostart ?? "login",
        localOnly: Boolean(service.localOnly),
        injects,
        ...(service.user ? { user: service.user } : {}),
        shutdownMs: 40000,
      });
    }
  }

  return { specs, problems };
}

// Retain previously prepared services when their bag manifest is unreadable; drop them only after a successful declaration change or registry removal.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-008
export function retainUnreadableBagServices(
  bags: readonly Bag[],
  specs: readonly ServiceSpec[],
  previous: Readonly<Record<string, ServiceSpec & { port?: number }>>,
): ServiceSpec[] {
  const unreadable = new Set(bags.filter((bag) => bag.manifest === null).map((bag) => bag.name));
  const declared = new Set(specs.map((spec) => spec.key));
  return Object.values(previous)
    .filter((spec) => unreadable.has(spec.bag) && !declared.has(spec.key))
    .map(({ port: _port, ...spec }) => spec);
}
