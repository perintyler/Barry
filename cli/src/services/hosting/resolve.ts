/**
 * Join the installation's hosting policy with what is registered, and refuse
 * anything unsafe before a provider ever sees it.
 *
 * Core owns these rules so no provider has to remember them: every way in is
 * checked here the same way, whichever vendor carries it. The output is one
 * routes file's content per installed provider bag. Any error means nothing
 * new is published: providers keep serving what they have applied, and
 * `barry hosting status` shows why.
 */
import type { BagHostingCapability } from "@barry-rocks/sdk/bags";
import type { HostingGate, HostingPolicy, LocalRoute, PublishedTunnel, RoutesFile } from "@barry-rocks/sdk/services";


/** A registered service, as hosting needs to see it. */
export interface HostedService {
  /** Registry name, `<bag>.<service>`. */
  key: string;
  bag: string;
  name: string;
  /** Registry URL; only `http://` services can be routed to. */
  url?: string;
  /** Declared `local-only: true`: no tunnel may route to it. */
  localOnly: boolean;
}

/** An installed bag that declares `provides:`. */
export interface HostingProvider {
  bag: string;
  provides: BagHostingCapability;
}

export type PublishedRoutes = Omit<RoutesFile, "generation" | "generated">;

export interface HostingPlan {
  /** Keyed by provider bag. Every installed provider gets an entry, so one the policy no longer uses tears its routes down. */
  published: Map<string, PublishedRoutes>;
  errors: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Addresses compare as numbers when they are ports, case-insensitively otherwise. */
function normalizeRouteAddress(address: string): string {
  const trimmed = address.trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed.toLowerCase();
}

/**
 * A service's default local name: its bag, or `<service>.<bag>` when the bag
 * has several HTTP services and the bag name alone would be ambiguous.
 */
function defaultLocalLabel(service: HostedService, httpServicesByBag: Map<string, number>): string {
  return (httpServicesByBag.get(service.bag) ?? 0) > 1 ? `${service.name}.${service.bag}` : service.bag;
}

export function resolveHosting(
  policy: HostingPolicy | null,
  services: HostedService[],
  providers: HostingProvider[],
): HostingPlan {
  const errors: string[] = [];
  const published = new Map<string, PublishedRoutes>();
  for (const p of providers) published.set(p.bag, { version: 1, provider: p.bag, tunnels: {} });
  if (!policy) return { published, errors };

  const servicesByKey = new Map(services.map((s) => [s.key, s]));
  const providerByBag = new Map(providers.map((p) => [p.bag, p]));
  const loopbackHttpServices = services.filter((s) => s.url && isLoopbackHttp(s.url));
  const httpServicesByBag = new Map<string, number>();
  for (const s of loopbackHttpServices) httpServicesByBag.set(s.bag, (httpServicesByBag.get(s.bag) ?? 0) + 1);

  /** Every full hostname handed out, and who has it, to catch collisions across local and tunnels. */
  const hostnameOwners = new Map<string, string>();
  const claimName = (hostname: string, owner: string) => {
    const lower = hostname.toLowerCase();
    const previous = hostnameOwners.get(lower);
    if (previous) errors.push(`${hostname} is claimed twice: by ${previous} and by ${owner}`);
    else hostnameOwners.set(lower, owner);
  };

  /** The service a route names, or an error saying why it cannot be routed to. */
  const findRoutableService = (key: string, where: string): HostedService | null => {
    const service = servicesByKey.get(key);
    if (!service) {
      errors.push(`${where}: ${key} is not a registered service (is its bag installed and enabled?)`);
      return null;
    }
    if (!service.url) {
      errors.push(`${where}: ${key} serves nothing to route to`);
      return null;
    }
    if (!isLoopbackHttp(service.url)) {
      errors.push(`${where}: ${key} is at ${service.url}, which is not an http address on loopback`);
      return null;
    }
    return service;
  };

  if (policy.local) {
    const local = policy.local;
    const provider = providerByBag.get(local.via);
    if (!provider) {
      errors.push(`local: via ${local.via}, which is not an installed bag`);
    } else if (!provider.provides.local) {
      errors.push(`local: ${local.via} does not provide local names (its manifest has no \`provides: local\`)`);
    } else {
      const routes: LocalRoute[] = [];
      const requestedServiceKeys =
        local.services === "all" ? loopbackHttpServices.map((s) => s.key) : local.services;
      for (const key of requestedServiceKeys) {
        if (key === local.root) continue;
        const service = findRoutableService(key, `local`);
        if (!service) continue;
        const label = local.rename[key] ?? defaultLocalLabel(service, httpServicesByBag);
        const hostname = `${label}.${local.domain}`;
        claimName(hostname, `local ${key}`);
        routes.push({ hostname, service: key, target: service.url! });
      }
      if (local.root) {
        const service = findRoutableService(local.root, "local root");
        if (service) {
          claimName(local.domain, `local root ${local.root}`);
          routes.push({ hostname: local.domain, service: local.root, target: service.url! });
        }
      }
      for (const key of Object.keys(local.rename)) {
        if (!servicesByKey.has(key)) errors.push(`local.rename: ${key} is not a registered service`);
      }
      published.get(local.via)!.local = { domain: local.domain, ...(local.root ? { root: local.root } : {}), routes };
    }
  }

  for (const [tunnelName, tunnel] of Object.entries(policy.tunnels)) {
    const where = `tunnel ${tunnelName}`;
    const provider = providerByBag.get(tunnel.via);
    if (!provider) {
      errors.push(`${where}: via ${tunnel.via}, which is not an installed bag`);
      continue;
    }
    const capability = provider.provides.tunnel;
    if (!capability) {
      errors.push(`${where}: ${tunnel.via} does not provide tunnels (its manifest has no \`provides: tunnel\`)`);
      continue;
    }
    if (!capability.reach.includes(tunnel.reach)) {
      errors.push(`${where}: ${tunnel.via} cannot carry ${tunnel.reach} routes (it provides ${capability.reach.join(", ")})`);
      continue;
    }

    const addressOwners = new Map<string, string>();
    const routes: PublishedTunnel["routes"] = [];
    for (const route of tunnel.routes) {
      const routeWhere = `${where} ${route.address}`;
      const previous = addressOwners.get(normalizeRouteAddress(route.address));
      if (previous) {
        errors.push(`${routeWhere}: the address is already used by ${previous}`);
        continue;
      }
      addressOwners.set(normalizeRouteAddress(route.address), route.service);

      const service = findRoutableService(route.service, routeWhere);
      if (!service) continue;
      if (service.localOnly) {
        errors.push(`${routeWhere}: ${service.key} is local-only (its security assumes callers on this Mac), so no tunnel may reach it`);
        continue;
      }
      const gate: HostingGate | undefined = route.gate ?? tunnel.gate;
      if (tunnel.reach === "public" && gate === undefined) {
        errors.push(`${routeWhere}: a public route needs a gate; set \`gate: access\`, or \`gate: none\` if ${service.key} authenticates its own requests`);
        continue;
      }
      if (gate === "access" && !capability.gates.includes("access")) {
        errors.push(`${routeWhere}: ${tunnel.via} cannot gate routes with access`);
        continue;
      }
      if (tunnel.domain) claimName(`${route.address}.${tunnel.domain}`, routeWhere);
      routes.push({ address: route.address, service: service.key, target: service.url!, gate: gate ?? "none" });
    }

    published.get(tunnel.via)!.tunnels[tunnelName] = {
      instance: tunnel.instance,
      reach: tunnel.reach,
      ...(tunnel.domain ? { domain: tunnel.domain } : {}),
      routes,
    };
  }

  return { published, errors };
}
