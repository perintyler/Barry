import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { checkRequirements, type HostProbes } from "@barry-rocks/sdk/adapters/models";

/** A local forecast, not a claim about the executable on a remote schedule worker. */
export function scheduleRuntime(adapterId: string, adapters: readonly InstalledAdapter[], probes: HostProbes) {
  const adapter = findInstalled(adapters, adapterId);
  if (!adapter?.modes.hosted) return { adapter: adapterId, scope: "local" as const, warning: "hosted adapter is not registered on this machine" };
  const checks = checkRequirements(adapter.requirements, probes, adapter.modes.hosted);
  return { adapter: adapter.id, scope: "local" as const, checks };
}
