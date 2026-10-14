import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, isScalar, parseDocument } from "yaml";
import { barryConfigDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";

/** Service env overrides for the node-era workflow links, now `barry workers join`. */
const RETIRED_ENV = /^BARRY_WORKFLOW_(?:OWNERS|WORKERS)=/;

/** Family copies of other nodes' sessions: nothing reads them any more. */
export function familyDirectories(): string[] {
  const path = join(activeStoreRoot(), "node", "family");
  return existsSync(path) ? [path] : [];
}

/**
 * `services.<service>.env` entries in barry.yaml naming a retired variable.
 * The service refuses an override for a variable its bag no longer declares,
 * so one left behind stops workflows.runtime from starting.
 */
export function retiredEnvOverrides(configPath = join(barryConfigDir(), "barry.yaml")): { service: string; entry: string }[] {
  if (!existsSync(configPath)) return [];
  const document = parseDocument(readFileSync(configPath, "utf8"));
  const services = document.get("services");
  if (!isMap(services)) return [];
  const found: { service: string; entry: string }[] = [];
  for (const pair of services.items) {
    const env = isMap(pair.value) ? pair.value.get("env") : undefined;
    if (!isSeq(env)) continue;
    for (const item of env.items) if (isScalar(item) && typeof item.value === "string" && RETIRED_ENV.test(item.value)) found.push({ service: String(isScalar(pair.key) ? pair.key.value : pair.key), entry: item.value });
  }
  return found;
}

function removeRetiredEnvOverrides(configPath: string): void {
  const document = parseDocument(readFileSync(configPath, "utf8"));
  const services = document.get("services");
  if (!isMap(services)) return;
  for (const pair of services.items) {
    const env = isMap(pair.value) ? pair.value.get("env") : undefined;
    if (!isSeq(env)) continue;
    env.items = env.items.filter(item => !(isScalar(item) && typeof item.value === "string" && RETIRED_ENV.test(item.value)));
  }
  writeFileSync(configPath, document.toString());
}

/**
 * Leftovers of the multi-node layer that an upgrade cannot clear by itself:
 * Family's copied databases, and node-era workflow links in barry.yaml. A
 * route that exposes workflows.runtime to the internet without a gate is
 * reported, never changed.
 */
export async function reportRetiredNodeState(fix: boolean, configPath = join(barryConfigDir(), "barry.yaml")): Promise<void> {
  const family = familyDirectories();
  const overrides = retiredEnvOverrides(configPath);
  if (family.length) {
    console.log("\nCopies of other nodes' sessions (Family) that nothing reads any more:");
    for (const path of family) console.log(`  ${path}`);
    if (fix) { for (const path of family) rmSync(path, { recursive: true, force: true }); console.log("  Removed."); }
    else console.log("  Re-run with --fix to remove them.");
  }
  if (overrides.length) {
    console.log("\nService overrides for node-era workflow links (a workflows service refuses to start with them):");
    for (const { service, entry } of overrides) console.log(`  ${service}: ${entry}`);
    console.log("  Owners are joined with `barry workers join <token>` now; get a token on the owner with `barry workers invite`.");
    if (fix) { removeRetiredEnvOverrides(configPath); console.log(`  Removed from ${configPath}.`); }
    else console.log("  Re-run with --fix to remove them.");
  }
  try {
    const { workflowsRoutes } = await import("./workers-url.js");
    const exposed = (await workflowsRoutes()).filter(route => route.reach === "public" && route.gate === "none");
    if (exposed.length) {
      console.log("\nworkflows.runtime is reachable from the internet without a gate, and it serves the runs console and its sign-in page:");
      for (const route of exposed) console.log(`  ${route.url}`);
      console.log("  Workers only need a private route; prefer one on a private tunnel in hosting.yaml.");
    }
  } catch { /* no hosting policy or registry to check */ }
}
