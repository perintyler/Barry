import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Adapters } from "@barry-rocks/sdk/adapters/harnesses";
import { checkRequirements, type HostProbes } from "@barry-rocks/sdk/adapters/models";
import { hostProbes } from "../commands/doctor.js";

/** Select usable shipped packages once; explicit selections retain ownership. */
export async function selectShippedSessionAdapters(root: string, adapters: Adapters, probes: HostProbes = hostProbes()): Promise<string[]> {
  const directory = join(root, "adapters/sessions");
  const selected: string[] = [];
  if (!existsSync(directory)) return selected;
  for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory() || child.name === "node_modules") continue;
    const path = join(directory, child.name);
    const file = join(path, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.barry?.sessionAdapter?.contractVersion !== 1) continue;
    const existing = adapters.installed().find(record => record.packageName === pkg.name);
    if (existing && realpathSync(existing.path) !== realpathSync(path)) continue;
    const entry = pkg.exports?.["."]?.import;
    if (typeof entry !== "string" || !entry.startsWith("./") || !existsSync(join(path, entry))) continue;
    const { default: adapter } = await import(pathToFileURL(join(path, entry)).href) as { default: Adapter };
    const mode = adapter.modes[adapter.defaultMode];
    if (!mode || mode.platforms && !mode.platforms.includes(probes.platform)) continue;
    if (adapter.requirements.platforms && !adapter.requirements.platforms.includes(probes.platform)) continue;
    const checks = checkRequirements(adapter.requirements, probes, mode);
    if (checks.find(check => check.name === "binary")?.status !== "ok" || checks.some(check => check.name === "compatibility" && check.status === "failed")) continue;
    if (adapters.installed().some(record => record.packageName !== pkg.name && [record.id, ...record.aliases ?? []].some(name => [adapter.id, ...adapter.aliases ?? []].includes(name)))) continue;
    const refreshed = await adapters.add(path);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(refreshed)) selected.push(adapter.id);
  }
  return selected;
}
