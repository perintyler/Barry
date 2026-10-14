import type { ServiceOS } from "@barry-rocks/mcp-bag";
import { managedServices, serviceRequest, type ServiceStatus } from "@barry-rocks/mcp-bag";

export interface StoreServices {
  statuses(): Promise<Pick<ServiceStatus, "key" | "pid" | "state">[]>;
  isSystem(key: string): boolean;
  stop(key: string): Promise<void>;
  start(key: string): Promise<void>;
}
export function storeServices(os?: ServiceOS): StoreServices {
  // Upgrade setup rewrites definitions; starting writes the plist from the definition it holds.
  const management = () => managedServices({ os });
  return {
    statuses: async () => (await serviceRequest({ op: "status" }, { management: management() })).services,
    isSystem: key => { const definition = management().definition(key); return definition.domain === "system" || Boolean(definition.user); },
    stop: async key => { await serviceRequest({ op: "stop", service: key }, { management: management() }); },
    start: async key => { await serviceRequest({ op: "start", service: key }, { management: management() }); },
  };
}
async function waitForService(services: StoreServices, key: string, running: boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  do {
    const status = (await services.statuses()).find(service => service.key === key);
    if (status && (running ? Boolean(status.pid) && status.state === "running" : !status.pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${key} did not ${running ? "start" : "stop"} within 30 seconds`);
}
async function restartServices(services: StoreServices, keys: string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const key of keys) {
    try { await services.start(key); await waitForService(services, key, true); }
    catch (error) { failures.push(new Error(`${key}: ${String(error)}`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, `could not restart services: ${failures.map(String).join("; ")}`);
}

export async function switchStoreGeneration<T extends { directory: string }>(options: {
  command: "Restore" | "Rollback" | "Recovery" | "Upgrade" | "Release rollback"; previous: string; services?: StoreServices;
  switch(stopAgain: () => Promise<void>): Promise<T>;
}): Promise<T> {
  const services = options.services ?? storeServices(), stopped: string[] = [];
  // Stop again before publication to include services started during preparation.
  const stopRunning = async (): Promise<void> => {
    for (const service of await services.statuses()) {
      if (!service.pid || services.isSystem(service.key)) continue;
      // A stop can take effect before reporting failure.
      if (!stopped.includes(service.key)) stopped.push(service.key);
      await services.stop(service.key);
      await waitForService(services, service.key, false);
    }
  };
  let result: T;
  try {
    await stopRunning();
    result = await options.switch(stopRunning);
  } catch (error) {
    try { await restartServices(services, stopped); }
    catch (restartError) { throw new AggregateError([error, restartError], `${options.command} failed: ${String(error)}. ${String(restartError)}`); }
    if (options.command === "Recovery") throw new Error(`Recovery failed: ${String(error)}; the services that were running were started again`, { cause: error });
    if (options.command === "Upgrade" || options.command === "Release rollback")
      throw new Error(`${options.command} failed; services restarted on ${options.command === "Upgrade" ? "the previous release" : "the release the upgrade installed"}: ${String(error)}`, { cause: error });
    throw new Error(`${options.command} failed; services restarted on the previous generation: ${String(error)}`, { cause: error });
  }
  try { await restartServices(services, stopped); }
  catch (error) {
    if (options.command === "Upgrade" || options.command === "Release rollback")
      throw new Error(`${options.command === "Upgrade" ? "Upgraded" : "Rolled back"} to ${result.directory}; ${options.previous} is kept for ` + "`barry upgrade --rollback`. " + String(error), { cause: error });
    const action = options.command === "Restore" ? "Restored" : options.command === "Rollback" ? "Rolled back" : "Recovered";
    throw new Error(`${action} to ${result.directory}; previous generation kept at ${options.previous}. ${String(error)}`, { cause: error });
  }
  return result;
}
