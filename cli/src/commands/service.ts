/** Local service management and independent process/health observations. */
import { Barry } from "@barry-rocks/sdk";
import { waitForServices } from "@barry-rocks/mcp-bag";
import { readServiceRegistry, serviceAddress, MCP_SERVER_KEY } from "@barry-rocks/sdk/services";
import { managedServices, serviceRequest, ServiceManagementError, type ServiceStatus } from "@barry-rocks/mcp-bag";

import { bold, dim, green, red, yellow } from "../lib/ansi.js";

async function statuses(): Promise<ServiceStatus[]> {
  return (await serviceRequest({ op: "status" })).services;
}

/** Service keys that changed, old to new: the MCP server became the `mcp` bag's `server`. */
const RENAMED_SERVICES: Record<string, string> = { "barry.mcp": MCP_SERVER_KEY };

/**
 * Turn what a person typed into registry names: a full name (`lists.web`),
 * a bag (every service it has), or `all`. Throws naming what matched nothing,
 * rather than doing nothing and reporting success.
 */
export function resolveServiceNames(names: string[], services: ServiceStatus[]): string[] {
  if (names.length === 0 || names.includes("all")) return services.map((s) => s.key);
  const keys: string[] = [];
  for (const typed of names) {
    // The old name means the old service while one still exists: removing it
    // is how an instance finishes the rename.
    const name = services.some((s) => s.key === typed) ? typed : RENAMED_SERVICES[typed] ?? typed;
    if (name !== typed) console.warn(`"${typed}" is now "${name}"; the old name is accepted for one release.`);
    const matches = services.filter((s) => s.key === name || s.bag === name);
    if (matches.length === 0) {
      throw new Error(`no service or bag named "${name}". \`barry service status\` lists them.`);
    }
    for (const m of matches) if (!keys.includes(m.key)) keys.push(m.key);
  }
  return keys;
}

/** Whether a service needs someone to look at it. */
function alarm(s: ServiceStatus): string | null {
  if (s.state === "conflict") return `port ${s.port} is held by ${s.conflict ?? "another program"}`;
  if (s.problem) return s.problem;
  if (s.loopbackOnly === false) return "listening beyond loopback";
  if (s.state === "backoff") return `restarting (exited ${s.restarts} times)`;
  if (s.state === "running" && s.health === "failing") return "health check failing";
  return null;
}

/**
 * Every service, or the ones named. Exits non-zero when any shown service
 * needs attention, or a named one is not running, so a script can gate on it.
 */
export async function statusCommand(names: string[] = [], options: { json?: boolean } = {}): Promise<void> {
  const { currentTarget } = await import("../target.js");
  const target = currentTarget();
  const reply = await serviceRequest({ op: "status" });
  let pool = reply.services;
  if (target.kind === "identity") {
    try {
      const { identityRecords } = await import("@barry-rocks/identities-bag");
      const id = await identityRecords.row(target.binding.id);
      const packedBags = new Set(id?.metadata.bags ?? []);
      pool = reply.services.filter(s => s.bag === "mcp" || s.bag === "sessions" || packedBags.has(s.bag));
    } catch {
      // Unreachable service control: keep the unfiltered pool.
    }
  }
  const wanted = new Set(resolveServiceNames(names, pool));
  const services = pool.filter((s) => wanted.has(s.key)).sort((a, b) => a.key.localeCompare(b.key));
  if (options.json) {
    console.log(JSON.stringify({ instance: reply.instance, services }, null, 2));
    if (services.some((s) => alarm(s)) || (names.length > 0 && services.some((s) => s.state !== "running"))) process.exitCode = 1;
    return;
  }
  const width = Math.max(...services.map((s) => s.key.length), 8);
  console.log();
  console.log(`  ${bold("Services")} ${dim(`· instance ${reply.instance.id}`)}`);
  console.log(`  ${dim("─".repeat(width + 30))}`);
  const alarms: string[] = [];
  for (const s of services) {
    const problem = alarm(s);
    if (problem) alarms.push(`${s.key} (${problem})`);
    const up = s.state === "running";
    const mark = problem ? red("✗") : up ? green("●") : dim("○");
    const port = s.port !== undefined ? String(s.port) : "";
    const state = s.state === "stopped" && s.autostart === "manual" ? "stopped (manual)" : s.state;
    const note = problem ? red(problem) : up ? dim(`pid ${s.pid} · health ${s.health}`) : "";
    console.log(`  ${mark} ${s.key.padEnd(width)} ${port.padStart(5)}  ${up ? state : dim(state)}  ${note}`);
  }
  console.log();
  const running = services.filter((s) => s.state === "running").length;
  const expected = services.filter((s) => s.autostart === "login").length;
  const notRunning = names.length > 0 ? services.filter((s) => s.state !== "running").map((s) => s.key) : [];
  if (alarms.length > 0 || notRunning.length > 0) process.exitCode = 1;
  if (alarms.length > 0) {
    console.log(`  ${red("✗")} ${bold(String(alarms.length))} need attention: ${alarms.join(", ")}`);
  } else if (notRunning.length > 0) {
    console.log(`  ${red("✗")} not running: ${notRunning.join(", ")}`);
  } else if (running >= expected) {
    console.log(`  ${green("✓")} ${bold(String(running))} services running`);
  } else {
    console.log(`  ${yellow("!")} ${bold(`${running}/${expected}`)} running`);
  }
  console.log();
}

function controlKeys(op: "start" | "stop" | "restart", names: string[], pool: ServiceStatus[]): string[] {
  const selected = names.includes("all")
    ? pool.filter(service => service.registered && service.enabled && !service.system &&
      (op === "start" ? service.state !== "running" : service.state === "running") &&
      (op !== "restart" || service.kind !== "app")).map(service => service.key)
    : resolveServiceNames(names, pool);
  return selected.sort((a, b) => a === MCP_SERVER_KEY ? 1 : b === MCP_SERVER_KEY ? -1 : a.localeCompare(b));
}

async function eachService(op: "start" | "stop" | "restart", names: string[], verb: string, dryRun = false): Promise<void> {
  const { assertLaunchd } = await import("../lib/platform.js");
  assertLaunchd();
  if (!names.length) throw new Error("name services or bags, or `all`");
  const keys = controlKeys(op, names, await statuses());
  console.log(`  ${verb}: ${keys.join(", ") || "none"}`);
  if (dryRun) {
    for (const key of keys) console.log(`  would ${op} ${key}`);
    return;
  }
  let failed = 0;
  for (const [index, key] of keys.entries()) {
    try {
      const service = op === "restart"
        ? await Barry.service(key).restart()
        : await Barry.service(key)[op]();
      if (op === "restart" && names.includes("all"))
        await waitForServices(managedServices(), [key], readServiceRegistry().resources, 60_000);
      console.log(`  ${green("✓")} ${verb} ${key} ${dim(`(${service.state})`)}`);
    } catch (err) {
      failed += 1;
      console.log(`  ${red("✗")} ${key}: ${err instanceof Error ? err.message : String(err)}`);
      if (op === "restart" && names.includes("all")) {
        const remaining = keys.slice(index + 1);
        if (remaining.length) console.log(`  not restarted: ${remaining.join(", ")}`);
        break;
      }
    }
  }
  if (failed > 0) process.exitCode = 1;
}

export async function startCommand(services: string[]): Promise<void> {
  await eachService("start", services, "started");
}

export async function stopCommand(services: string[]): Promise<void> {
  await eachService("stop", services, "stopped");
}

export async function serviceRestartCommand(services: string[], options: { dryRun?: boolean } = {}): Promise<void> {
  await eachService("restart", services, "restarted", options.dryRun);
}

/** `barry service port <service> <port>`: move it, and wait for every route that targets it. */
export async function servicePortCommand(service: string, port: string): Promise<void> {
  if (!/^\d+$/.test(port)) throw new Error(`"${port}" is not a port number`);
  const { moveServicePort } = await import("../services/barry.js");
  const reply = await serviceRequest({ op: "move-port", service, port: Number(port) }, { timeoutMs: 120_000, movePort: moveServicePort });
  console.log(`  ${green("✓")} ${service}: ${reply.from} → ${reply.to}`);
  if (reply.restarted.length) console.log(`  ${dim(`restarted ${reply.restarted.join(", ")}`)}`);
  const stuck = reply.routes.filter((r) => !r.applied);
  for (const r of reply.routes) {
    console.log(`  ${r.applied ? green("✓") : red("✗")} ${r.provider} ${r.route} ${r.applied ? "follows" : "has not applied the new target"}`);
  }
  if (stuck.length > 0) {
    throw new Error(`${stuck.length} route(s) did not converge: ${stuck.map((r) => r.route).join(", ")}`);
  }
}

/**
 * Restart one managed service (for commands whose change needs it, like
 * the engine after a bag install). False, with the reason printed, when the operation fails. Service management needs no running Barry application.
 */
export async function restartManagedService(key: string): Promise<boolean> {
  try {
    await Barry.service(key).restart();
    return true;
  } catch (err) {
    console.log(`  ${yellow("!")} could not restart ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Refresh installed declarations, register new defaults without activation, and remove
 * registrations whose declarations disappeared. Preserve explicit disabled and removed choices.
 */
export async function reconcileServices(): Promise<{ started: string[]; stopped: string[] } | null> {
  try {
    // The controller is injected: control.ts must not reach bag loading, and
    // without it every reconcile failed and no install, pack or unpack
    // refreshed a service.
    const { refreshInstalledServices } = await import("../services/barry.js");
    return await serviceRequest({ op: "reconcile" }, { timeoutMs: 60_000, reconcile: refreshInstalledServices });
  } catch (err) {
    if (err instanceof ServiceManagementError) return null;
    throw err;
  }
}

/**
 * Print where a service listens, e.g. `http://127.0.0.1:4885`, for scripts and
 * prompts that call a service directly. Takes a registry name, or a bag with
 * exactly one service. Reads the registry the service management wrote.
 */
export async function serviceUrlCommand(name: string): Promise<void> {
  const { resources } = readServiceRegistry();
  const keys = name.includes(".") ? [name] : Object.keys(resources).filter((k) => resources[k].bag === name && resources[k].url);
  if (keys.length !== 1) {
    throw new Error(
      keys.length === 0
        ? `no service named "${name}" in this instance's registry. \`barry service status\` lists them.`
        : `${name} has several services (${keys.join(", ")}); name one.`,
    );
  }
  console.log(serviceAddress(keys[0]));
}

