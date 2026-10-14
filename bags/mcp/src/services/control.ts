import { existsSync, readFileSync } from "node:fs";
import { probeHealth } from "./health.js";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openInstance, type Instance } from "@barry-rocks/sdk/internal/services";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { serviceOS, type ServiceOS } from "./launchd.js";
import { ServiceManagement, type ServiceDefinition } from "./management.js";
import type { ServiceStatus } from "./status.js";
import { readServiceRegistry } from "@barry-rocks/sdk/services";
import { tailLog } from "./logs.js";
import { listeningAddresses, portHolder } from "./listeners.js";
export type { ServiceStatus } from "./status.js";
export class ServiceManagementError extends Error {}
async function processStartedAt(pid: number | undefined): Promise<string | undefined> {
  if (!pid) return undefined;
  try {
    const value = Date.parse(
      (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
      })).stdout.trim(),
    );
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
  } catch {
    return undefined;
  }
}
export interface ServiceReplies {
  status: { instance: Instance; services: ServiceStatus[] };
  start: { service: ServiceStatus };
  stop: { service: ServiceStatus };
  restart: { service: ServiceStatus };
  logs: { service: string; stdout: string; stderr: string };
  reconcile: { started: string[]; stopped: string[] };
  "move-port": {
    service: string;
    from: number;
    to: number;
    restarted: string[];
    routes: Array<{ provider: string; route: string; applied: boolean }>;
  };
}
export type ServiceRequest =
  | { op: "status"; service?: string }
  | { op: "reconcile" }
  | { op: "start" | "stop" | "restart"; service: string }
  | { op: "logs"; service: string; lines?: number }
  | { op: "move-port"; service: string; port: number };
// Monitoring must not configure bags or load providers just to observe services.
export function managedServices(options: { instance?: Instance; os?: ServiceOS } = {}): ServiceManagement {
  const instance = options.instance ?? openInstance(barryAppSupportDir());
  const path = join(instance.home, "managed-definitions.json");
  const definitions = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as ServiceDefinition[]
    : [];
  return new ServiceManagement(instance, definitions, options.os ?? serviceOS());
}

export interface ServiceControlOptions {
  timeoutMs?: number;
  management?: ServiceManagement;
  reconcile?: () => Promise<ServiceReplies["reconcile"]>;
  movePort?: (service: string, port: number) => Promise<ServiceReplies["move-port"]>;
}

/** Local operations on prepared services; application configuration is injected. */
export async function serviceRequest<R extends ServiceRequest>(
  request: R,
  options: ServiceControlOptions = {},
): Promise<ServiceReplies[R["op"]]> {
  if (request.op === "reconcile") {
    if (!options.reconcile) throw new ServiceManagementError("reconcile requires an application service controller");
    return await options.reconcile() as ServiceReplies[R["op"]];
  }
  if (request.op === "move-port") {
    if (!options.movePort) throw new ServiceManagementError("move-port requires an application service controller");
    return await options.movePort(request.service, request.port) as ServiceReplies[R["op"]];
  }
  const management = options.management ?? managedServices();
  const resources = readServiceRegistry().resources;
  const observe = async (name: string): Promise<ServiceStatus> => {
    const state = await management.status(name),
      definition = management.definition(name),
      resource = resources[name];
    let portProblem: string | undefined;
    try {
      const operation = JSON.parse(
        readFileSync(
          join(management.instance.home, `port-${name}.json`),
          "utf8",
        ),
      ) as { phase: string; to: number };
      if (operation.phase !== "complete")
        portProblem = `incomplete port change (${operation.phase}); retry barry service port ${name} ${operation.to}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const url = resource?.url;
    const port = url?.startsWith("http")
      ? Number(new URL(url).port) || undefined
      : undefined;
    const holder = port !== undefined && !state.pid ? await portHolder(port) : null;
    const conflict = holder && !state.pid ? holder : undefined;
    const health = state.pid
      ? await probeHealth(url, definition.health)
      : "unknown";
    const addresses = state.pid ? await listeningAddresses([state.pid]) : null;
    const loopback =
      addresses === null
        ? null
        : addresses.some(
            (address) =>
              !address.startsWith("127.") && !address.startsWith("[::1]:"),
          );
    return {
      key: name,
      bag: resource?.bag ?? name.split(".")[0],
      name: resource?.name ?? name.split(".").slice(1).join("."),
      kind: resource?.kind ?? "service",
      system: definition.domain === "system" || Boolean(definition.user),
      lastExitCode: state.lastExitCode,
      state: state.state === "unsupported" ? "unsupported" : conflict
        ? "conflict"
        : state.pid
          ? "running"
          : state.loaded
            ? state.state?.includes("waiting")
              ? "backoff"
              : "starting"
            : "stopped",
      registered: state.registered,
      enabled: state.enabled,
      pending: state.pending,
      logs: state.logs,
      autostart: state.enabled ? "login" : "manual",
      pid: state.pid,
      port,
      url,
      workingDirectory: definition.directory,
      argv: [...definition.command],
      restarts: Math.max(0, (state.runs ?? 1) - 1),
      startedAt: await processStartedAt(state.pid),
      health,
      ...(loopback !== null ? { loopbackOnly: !loopback } : {}),
      ...(loopback ? { problem: "service is bound to a non-loopback address" } : {}),
      ...(conflict ? { conflict } : {}),
      ...(portProblem ? { problem: portProblem } : {}),
      ...((definition.domain === "system" || Boolean(definition.user)) && !state.registered
        ? {
            problem:
              "needs `sudo barry setup --system`",
          }
        : {}),
      ...(state.pending
        ? { problem: `incomplete ${state.pending}; retry the operation` }
        : {}),
      stdoutLog: join(definition.logDirectory, `${name}.out.log`),
      stderrLog: join(definition.logDirectory, `${name}.err.log`),
    };
  };
  if (request.op === "status") {
    const names = request.service ? [request.service] : management.names(), services: ServiceStatus[] = [];
    for (let i = 0; i < names.length; i += 6)
      services.push(...await Promise.all(names.slice(i, i + 6).map(observe)));
    return { instance: management.instance, services } as ServiceReplies[R["op"]];
  }
  if (request.op === "logs") {
    const status = await observe(request.service);
    return {
      service: request.service,
      stdout: tailLog(status.stdoutLog!, request.lines ?? 100),
      stderr: tailLog(status.stderrLog!, request.lines ?? 100),
    } as ServiceReplies[R["op"]];
  }
  await management.apply(request.service, request.op);
  return { service: await observe(request.service) } as ServiceReplies[R["op"]];
}
