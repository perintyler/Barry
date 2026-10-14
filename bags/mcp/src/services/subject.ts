import { Barry, BarryError, type Caller, type Service, type Services } from "@barry-rocks/sdk";
import { managedServices, serviceRequest, type ServiceStatus } from "./control.js";
import { ServiceRefusal } from "./management.js";

function serviceOf(status: ServiceStatus): Service {
  return {
    key: status.key, bag: status.bag, name: status.name, kind: status.kind ?? "service",
    state: status.state, registered: status.registered ?? false, enabled: status.enabled ?? false,
    system: status.system ?? false, pid: status.pid ?? null, port: status.port ?? null,
    address: status.url ?? null, health: status.health, restarts: status.restarts,
    startedAt: status.startedAt ?? null, lastExitCode: status.lastExitCode ?? null,
    workingDirectory: status.workingDirectory, loopbackOnly: status.loopbackOnly ?? null,
    conflict: status.conflict ?? null, problem: status.problem ?? null,
  };
}

function allowRead(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "devices cannot control or observe services");
}

async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ServiceRefusal) throw new BarryError(error.reason === "unsupported" ? "forbidden" : error.reason, error.message);
    throw error;
  }
}

async function control(key: string, caller: Caller, op: "start" | "stop" | "restart"): Promise<Service> {
  allowRead(caller);
  const management = managedServices();
  return translated(async () => {
    const current = (await serviceRequest({ op: "status", service: key }, { management })).services[0];
    if (caller.kind === "session" && caller.bag !== current.bag) {
      const grants = await Barry.as(caller).identity(caller.identity).session(caller.sessionId).grants();
      if (!grants.tools.some(tool => tool.namespace === "mcp" && tool.name === "services_restart" && tool.access === "write"))
        throw new BarryError("forbidden", `this session is not granted service control`, "select the mcp:services trait with readwrite access");
    }
    if (op !== "start" && key === process.env.BARRY_SERVICE)
      throw new BarryError("conflict", `a service cannot ${op} itself`, `barry service restart ${key}`);
    return serviceOf((await serviceRequest({ op, service: key }, { management })).service);
  });
}

export const services: Services = {
  name: "services",
  async list(caller) {
    allowRead(caller);
    return translated(async () => (await serviceRequest({ op: "status" }, { management: managedServices() })).services.map(serviceOf));
  },
  async get(key, caller) {
    allowRead(caller);
    return translated(async () => serviceOf((await serviceRequest({ op: "status", service: key }, { management: managedServices() })).services[0]));
  },
  start: (key, caller) => control(key, caller, "start"),
  stop: (key, caller) => control(key, caller, "stop"),
  restart: (key, caller) => control(key, caller, "restart"),
};
