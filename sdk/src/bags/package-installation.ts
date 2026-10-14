import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { hostEnvironment } from "../services/host-env.js";
import { resolveBinary } from "./bag-dependencies.js";
import type { BagDependency } from "./types.js";

export interface PackageInstallation {
  state: "installed" | "absent" | "unknown";
  manager?: "homebrew" | "dpkg";
}
const inventories = new Map<string, { expires: number; names: Set<string> | null }>();

/** Read both package classes without evaluating authored installation commands. */
export function homebrewInventory(binary: string, env: Record<string, string | undefined>): Set<string> | null {
  try {
    const names = new Set<string>();
    for (const args of [["list", "--formula", "--full-name", "-1"], ["list", "--cask", "-1"]]) {
      const output = execFileSync(binary, args, {
        encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], env: { ...hostEnvironment(env), HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1" },
      });
      for (const name of output.split(/\r?\n/).filter(Boolean)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9@._/+:-]*$/.test(name)) return null;
        names.add(name);
      }
    }
    return names;
  } catch { return null; }
}

/** Query package status, excluding removed and partially installed records. */
export function dpkgInventory(binary: string, env: Record<string, string | undefined>): Set<string> | null {
  try {
    const output = execFileSync(binary, ["--show", "--showformat=${binary:Package}\\t${db:Status-Status}\\n"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], env: { ...hostEnvironment(env), LC_ALL: "C" },
    });
    const names = new Set<string>();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const match = /^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?)\t(not-installed|config-files|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|installed)$/.exec(line);
      if (!match) return null;
      if (match[2] === "installed") { names.add(match[1]); names.add(match[1].split(":")[0]); }
    }
    return names;
  } catch { return null; }
}

/** Installation hints identify the manager; they are never executed. */
export function packageInstallation(dependency: BagDependency, env: Record<string, string | undefined> = process.env): PackageInstallation {
  if (!dependency.package) return { state: "unknown" };
  const hint = dependency.install ?? "";
  const manager = /^brew\s+install(?:\s|$)/.test(hint) ? "homebrew"
    : /^(?:sudo\s+)?apt(?:-get)?\s+install(?:\s|$)/.test(hint) ? "dpkg" : undefined;
  if (!manager) return { state: "unknown" };
  const binary = resolveBinary(manager === "homebrew" ? "brew" : "dpkg-query", env);
  if (!binary) return { state: "unknown", manager };
  const key = JSON.stringify([manager, binary, env.HOME, env.PATH]);
  let inventory = inventories.get(key);
  if (!inventory || inventory.expires <= Date.now()) {
    inventory = { expires: Date.now() + 30000, names: manager === "homebrew" ? homebrewInventory(binary, env) : dpkgInventory(binary, env) };
    inventories.set(key, inventory);
    if (inventories.size > 32) inventories.delete(inventories.keys().next().value!);
  }
  if (!inventory.names) return { state: "unknown", manager };
  const installed = inventory.names.has(dependency.package) || (manager === "homebrew" && !dependency.package.includes("/") && [...inventory.names].some(name => basename(name) === dependency.package));
  return { state: installed ? "installed" : "absent", manager };
}
