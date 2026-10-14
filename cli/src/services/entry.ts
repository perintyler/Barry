import { acquireLock, installationSecrets, stableNodePath } from "@barry-rocks/sdk/internal/services";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { hostEnvironment, bagDataDir } from "@barry-rocks/sdk/services";
import { installationEnvironment } from "./installation-environment.js";



import type { ServiceSpec } from "./specs.js";
import { accessSync, constants } from "node:fs";

/** Replace this process rather than spawning a persistent wrapper. */
export async function executeService(home: string, name: string): Promise<never> {
  const definitions = JSON.parse(
    readFileSync(join(home, "service-definitions.json"), "utf8"),
  ) as Record<string, ServiceSpec & { port?: number }>;
  const spec = definitions[name];
  if (!spec || spec.key !== name)
    throw new Error(`no prepared service named ${name}`);
  for (const entry of spec.env ?? []) {
    if (entry.source !== "value" || typeof entry.value !== "string") throw new Error(`${spec.key}: service environment must contain literal values; use named secret bindings`);
  }
  const path = [
    dirname(stableNodePath()),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const env: Record<string, string> = { ...hostEnvironment(), PATH: path, BARRY_SERVICE: spec.key };
  env.BARRY_BAG_DATA_DIR = bagDataDir(spec.bag);
  const optionalSecrets = spec.optionalSecrets ?? [];
  for (const entry of installationEnvironment(spec.key, spec.env ?? [], [...(spec.secrets ?? []), ...optionalSecrets])) {
    env[entry.name] = entry.value;
  }
  if (spec.port !== undefined) env.PORT = String(spec.port);
  const secrets = await installationSecrets([...(spec.secrets ?? []), ...optionalSecrets], { optionalNames: optionalSecrets });
  for (const [name, secret] of Object.entries(secrets)) {
    if (name in env) throw new Error(`${spec.key}: secret ${name} conflicts with an environment binding`);
    env[name] = secret;
  }
  const command = isAbsolute(spec.command)
    ? spec.command
    : path
        .split(":")
        .map((directory) => join(directory, spec.command))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
  if (!command) throw new Error(`cannot find executable ${spec.command}`);
  acquireLock(home, `service-${name}`);
  process.chdir(spec.cwd);
  const runtime = process as typeof process & {
    execve(file: string, args: string[], env: Record<string, string>): never;
  };
  if (typeof runtime.execve !== "function")
    throw new Error("service execution requires Node 26 with process.execve");
  return runtime.execve(command, [command, ...spec.args], env);
}

/** `barry-service <home> <key>`: run one prepared service. */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const [home, name] = argv;
  if (!home || !name)
    throw new Error("service entry requires an instance home and service name");
  void executeService(home, name).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) main();
