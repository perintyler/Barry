import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { barryAppSupportDir, readServiceRegistry } from "@barry-rocks/sdk/services";
import { stableNodePath } from "@barry-rocks/sdk/internal/services";
import { loadAllBags } from "@barry-rocks/sdk/internal/bags";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { ownerCall } from "@barry-rocks/sdk/internal/workflows";
import { currentInstallation } from "../releases/current.js";
import { cliShimDir } from "../lib/identity-shims.js";
import { installedServices, serviceDrift } from "../services/barry.js";
import { nodeRuntime } from "../services/runtime.js";
import { probeHealth } from "@barry-rocks/mcp-bag";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";

import { parse } from "yaml";
import { convertLegacyBound, SHIPPED_GLOBAL_BOUND_NAMES } from "./doctor-migration.js";

export interface InstallCheck { name: string; status: "pass" | "fail"; detail: string }

/**
 * Verify that root `identity.yaml` defines all 5 shipped global bounds with
 * non-empty rules, and that every bag job's `bounds` references resolve to a
 * declared bound in root `identity.yaml` or `<bag>:<bound>` in `bag.yaml`.
 */
export async function checkShippedBounds(rootIdentityYamlPath?: string): Promise<string> {
  const current = currentInstallation();
  const candidatePath =
    rootIdentityYamlPath ??
    (current.root && existsSync(join(current.root, "identity.yaml"))
      ? join(current.root, "identity.yaml")
      : undefined);

  let yamlPath = candidatePath;
  if (!yamlPath) {
    const { identityRecords } = await import("@barry-rocks/identities-bag");
    const builtinDir = identityRecords.builtinDirectory?.();
    if (builtinDir && existsSync(join(builtinDir, "identity.yaml"))) {
      yamlPath = join(builtinDir, "identity.yaml");
    }
  }
  if (!yamlPath || !existsSync(yamlPath)) {
    throw new Error("root identity.yaml is missing");
  }

  const parsed = parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown> | null;
  const rawBounds = Array.isArray(parsed?.bounds) ? parsed.bounds : [];
  const globalByName = new Map<string, Record<string, unknown>>();
  for (const entry of rawBounds) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name === "string") {
      globalByName.set(obj.name, convertLegacyBound(obj));
    } else {
      const k = Object.keys(obj)[0];
      const v = k ? obj[k] : undefined;
      if (k && v && typeof v === "object" && !Array.isArray(v)) {
        globalByName.set(k, convertLegacyBound(v as Record<string, unknown>));
      }
    }
  }

  for (const requiredName of SHIPPED_GLOBAL_BOUND_NAMES) {
    const rules = globalByName.get(requiredName);
    if (!rules) {
      throw new Error(`root identity.yaml is missing shipped global bound '${requiredName}'`);
    }
    const hasDimension = ["tools", "inputs", "files", "bash", "network", "nodes"].some(
      (dim) => rules[dim] !== undefined,
    );
    if (!hasDimension) {
      throw new Error(`shipped global bound '${requiredName}' has no restriction rules`);
    }
  }

  let allBags: Awaited<ReturnType<typeof loadAllBags>> = [];
  try {
    allBags = await loadAllBags();
  } catch {
    allBags = [];
  }
  const knownBounds = new Set<string>(globalByName.keys());
  for (const bag of allBags) {
    for (const bName of Object.keys(bag.manifest?.bounds ?? {})) {
      knownBounds.add(bName);
      knownBounds.add(`${bag.name}:${bName}`);
    }
  }
  for (const bag of allBags) {
    if (!bag.manifest?.jobs) continue;
    for (const job of Object.values(bag.manifest.jobs)) {
      for (const name of job.bounds ?? []) {
        if (!knownBounds.has(name) && !knownBounds.has(`${bag.name}:${name}`)) {
          throw new Error(`${bag.name}: unknown bound ${name}`);
        }
      }
    }
  }

  return "shipped global bounds and job bounds are valid";
}

/** Diagnostics never repair or provision an absent install. Each independent failure survives. */
export async function installationChecks(): Promise<InstallCheck[]> {
  const checks: InstallCheck[] = [];
  const check = async (name: string, probe: () => Promise<string> | string) => {
    try { checks.push({ name, status: "pass", detail: await probe() }); }
    catch (error) { checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) }); }
  };
  await check("current", () => {
    const current = currentInstallation();
    if (!current.current || current.kind === "missing") throw new Error("current must be a symlink to an existing installation");
    if (!existsSync(join(current.root, "identity.yaml"))) throw new Error("current target has no identity.yaml");
    accessSync(join(current.root, "bin/barry"), constants.X_OK);
    return current.target!;
  });
  const shim = join(cliShimDir(), "barry");
  await check("shim", () => { accessSync(shim, constants.X_OK); return shim; });
  await check("path", () => {
    if (!(process.env.PATH ?? "").split(":").includes(cliShimDir())) throw new Error(`${cliShimDir()} is not on PATH`);
    return cliShimDir();
  });
  await check("node", () => {
    if (!existsSync(shim)) throw new Error("shim does not pin Node");
    const text = readFileSync(shim, "utf8");
    const pinned = /^export BARRY_NODE=(.+)$/m.exec(text)?.[1];
    let node: string;
    if (pinned) {
      node = pinned.startsWith("'") && pinned.endsWith("'")
        ? pinned.slice(1, -1).replaceAll("'\\''", "'") : pinned;
    } else if (currentInstallation().kind === "release") {
      // A release wrapper selects its shipped runtime without BARRY_NODE.
      node = stableNodePath();
    } else throw new Error("shim does not pin Node");
    accessSync(node, constants.X_OK);
    const observed = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    if (observed.split(".")[0] !== `v${nodeRuntime().version.split(".")[0]}`) throw new Error(`Node ${observed} differs from pinned major ${nodeRuntime().version}`);
    if (observed.startsWith("v26.") && Number(observed.split(".")[1]) < 9) throw new Error("Node 26.9 or newer is required for process.execve service handoff");
    return `${node}: ${observed}`;
  });
  await check("session-adapter", () => {
    const installed = loadAdapters({ file: barryAdaptersPath() }).installed();
    if (installed.length === 0) throw new Error("no session adapter selected; install one, then run: barry adapter add adapters/sessions/<name>");
    return installed.map(adapter => adapter.id).join(", ");
  });
  // Opening bag stores on an uninstalled tree would create data doctor is meant to inspect.
  if (!existsSync(join(barryAppSupportDir(), "instance.json"))) {
    for (const name of ["services", "bounds", "owner", "nodes"]) checks.push({ name, status: "fail", detail: "installation record is missing" });
    return checks;
  }
  await check("services", async () => {
    const management = await installedServices();
    const drift = await serviceDrift();
    if (drift.unprepared.length || drift.unregistered.length) throw new Error(`unprepared: ${drift.unprepared.join(", ")}; unregistered: ${drift.unregistered.join(", ")}`);
    const services = await management.list();
    if (services.some(service => service.state === "unsupported")) throw new Error("services: unsupported on this host");
    const resources = readServiceRegistry().resources;
    for (const service of services) await check(`service:${service.name}`, async () => {
      if (!service.registered) throw new Error("not registered");
      if (service.enabled && !service.pid) throw new Error("enabled but not running");
      const definition = management.definition(service.name);
      if(service.name==="sessions.api" && service.pid && process.platform==="darwin") {
        const env=execFileSync("/bin/ps",["eww","-p",String(service.pid)],{encoding:"utf8",timeout:3000});
        const split=/\bBARRY_NAMESPACE_SPLIT=(\S+)/.exec(env)?.[1];
        if(split==="1"||split==="true")throw new Error("BARRY_NAMESPACE_SPLIT drifts from the bag manifest (false); restart sessions.api. Split tools belong in identity adapter settings");
      }
      if (service.enabled && definition.health && await probeHealth(resources[service.name]?.url, definition.health) !== "ok") throw new Error("unhealthy");
      return service.enabled ? "enabled, running and healthy" : "disabled as chosen";
    });
    const failed = checks.filter(check => check.name.startsWith("service:") && check.status === "fail");
    if (failed.length) throw new Error(failed.map(check => `${check.name.slice(8)}: ${check.detail}`).join("; "));
    return `${services.length} registered services; enabled services are healthy`;
  });
  await check("bounds", async () => checkShippedBounds());
  await check("owner", async () => {
    const { owner } = await import("@barry-rocks/identities-bag");
    const record = owner.installation().current();
    if (!record) throw new Error("installation has no owner");
    return `${record.actorId} ${record.name}`;
  });
  await check("nodes", async () => {
    if (!existsSync(join(activeStoreRoot(), "node", "nodes", "peers.db"))) return "no node links recorded";
    const registry = installationRegistry();
    for (const owner of registry.owners()) await check(`node:owner:${owner.name}`, async () => {
      const result = await ownerCall(owner.url, registry.ownerCredential(owner.id))({ version: 2, operation: "probe" });
      if (!result || typeof result !== "object" || !("owner" in result) || result.owner !== owner.id) throw new Error("probe identified another owner");
      return "authenticated read-only probe answered";
    });
    for (const worker of registry.workers()) await check(`node:worker:${worker.name}`, () => {
      throw new Error("pull worker has no callable endpoint; presence cannot be probed");
    });
    return `${registry.owners().length} owners and ${registry.workers().length} invited workers checked`;
  });
  return checks;
}
