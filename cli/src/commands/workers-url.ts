import { loadAllBags } from "@barry-rocks/sdk/internal/bags";
import { readHostingPolicy, hostingPolicyPath, readApplied, readServiceRegistry } from "@barry-rocks/sdk/services";
import { resolveHosting, type HostedService } from "../services/hosting/resolve.js";
import type { AppliedFile } from "@barry-rocks/sdk/services";



/** The service a worker calls: the workflows bag's runtime. */
export const WORKFLOWS_SERVICE = "workflows.runtime";

export interface WorkflowsRoute { url: string; reach: string; gate: string }

/**
 * Every address hosting.yaml publishes the workflows runtime at.
 *
 * Recomputed from the policy the way `barry hosting status` does it, so an
 * invite names the address the tunnel actually serves rather than a guess.
 */
export async function workflowsRoutes(): Promise<WorkflowsRoute[]> {
  const policy = readHostingPolicy();
  if (!policy) return [];
  const registry = readServiceRegistry();
  const bags = await loadAllBags();
  const localOnly = new Set(bags.flatMap((b) => (b.services ?? []).filter((s) => s.localOnly).map((s) => `${b.name}.${s.name}`)));
  const services: HostedService[] = Object.entries(registry.resources)
    .filter(([, e]) => e.kind === "service")
    .map(([key, e]) => ({ key, bag: e.bag, name: e.name, ...(e.url ? { url: e.url } : {}), localOnly: localOnly.has(key) }));
  const providers = bags.flatMap((b) => (b.manifest?.provides ? [{ bag: b.name, provides: b.manifest.provides }] : []));
  return routesFor(resolveHosting(policy, services, providers), readApplied);
}

/** The workflows routes in a resolved hosting plan, as https addresses a worker can call. */
export function routesFor(plan: ReturnType<typeof resolveHosting>, applied: (provider: string) => AppliedFile | null): WorkflowsRoute[] {
  const routes: WorkflowsRoute[] = [];
  for (const [provider, published] of plan.published) {
    const report = applied(provider);
    for (const t of Object.values(published.tunnels)) {
      for (const r of t.routes) {
        if (r.service !== WORKFLOWS_SERVICE) continue;
        if (t.domain) {
          routes.push({ url: `https://${r.address}.${t.domain}`, reach: t.reach, gate: r.gate });
          continue;
        }
        // A tunnel without a domain addresses its instance by the name the provider reported, port as the route.
        const host = report?.instances?.[t.instance]?.address;
        if (host) routes.push({ url: `https://${host}:${r.address}`, reach: t.reach, gate: r.gate });
      }
    }
  }
  return routes;
}

/**
 * The one address an invite should carry.
 *
 * Refuses a route behind an interactive gate: a worker cannot pass a browser
 * login, so the invite would hand out an address that never answers it.
 */
export async function workflowsUrl(): Promise<string> {
  return chooseWorkflowsUrl(await workflowsRoutes());
}

export function chooseWorkflowsUrl(routes: WorkflowsRoute[]): string {
  const usable = routes.filter((route) => route.gate === "none");
  if (usable.length === 1) return usable[0].url;
  if (usable.length > 1) {
    throw new Error(`${WORKFLOWS_SERVICE} is published at ${usable.length} addresses (${usable.map((route) => route.url).join(", ")}); pass the one this worker should use with --url`);
  }
  if (routes.length) {
    throw new Error(`${WORKFLOWS_SERVICE} is only published behind an interactive login gate (${routes.map((route) => route.url).join(", ")}), which a worker cannot pass. Add a private route for it in ${hostingPolicyPath()}, or pass --url`);
  }
  throw new Error(`${WORKFLOWS_SERVICE} is not published beyond this machine. Add a route for it to a private tunnel in ${hostingPolicyPath()} (published on the next \`barry up\`; check with \`barry hosting status\`), or pass --url`);
}
