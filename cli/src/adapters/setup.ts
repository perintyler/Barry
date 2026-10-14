import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    if (adapters.installed().some(record => record.packageName === pkg.name)) continue;
    const entry = pkg.exports?.["."]?.import;
    if (typeof entry !== "string" || !entry.startsWith("./") || !existsSync(join(path, entry))) continue;
    const { default: adapter } = await import(pathToFileURL(join(path, entry)).href) as { default: Adapter };
    const checks = checkRequirements(adapter.requirements, probes);
    const version = checks.find(check => check.name === "version");
    if (checks.find(check => check.name === "binary")?.status !== "ok" || version?.status !== "ok") continue;
    const mode = adapter.modes[adapter.defaultMode];
    if (!mode || mode.platforms && !mode.platforms.includes(probes.platform)) continue;
    if (adapter.requirements.platforms && !adapter.requirements.platforms.includes(probes.platform)) continue;
    // The launch guard permits patch/minor drift, but refuses another major.
    const major = (value: string) => /^\D*(\d+)/.exec(value)?.[1];
    if (mode.build !== "bundled" && major(version.observed) !== major(mode.verifiedOn)) continue;
    if (adapters.installed().some(record => [record.id, ...record.aliases ?? []].some(name => [adapter.id, ...adapter.aliases ?? []].includes(name)))) continue;
    await adapters.add(path);
    selected.push(adapter.id);
  }
  return selected;
}
