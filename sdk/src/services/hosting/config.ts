/**
 * `~/.config/barry/hosting.yaml`: what this installation exposes, and where.
 *
 * Hosting is a decision about an installation, not a property of the software,
 * so it lives here rather than in bag manifests. It is written in
 * vendor-neutral words: `local` is reaching services from this Mac by name,
 * and each entry under `tunnels` is one way in from elsewhere. Which software
 * does the work is named by `via` (a provider bag), and which of that
 * provider's daemons or accounts by `instance`, defined in the provider's own
 * config file.
 *
 * Grouped by tunnel because the question a security review asks is "what does
 * this way in carry"; `barry hosting status <service>` answers the other one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { barryConfigDir } from "../home.mjs";

const Gate = z.enum(["access", "none"]);

/** A route is a registry name, or one with its own gate. */
const RouteSchema = z.union([
  z.string().min(1),
  z.object({ service: z.string().min(1), gate: Gate.optional() }).strict(),
]);

const LocalSchema = z.object({
  via: z.string().min(1),
  domain: z.string().min(1),
  /** The service the bare domain itself names (`https://home.test`, beside `https://lists.home.test`). */
  root: z.string().min(1).optional(),
  /** `all` HTTP services, or the registry names to give a name. */
  services: z.union([z.literal("all"), z.array(z.string().min(1))]).default("all"),
  /** Registry name → the label to use instead of the default. */
  rename: z.record(z.string(), z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)).default({}),
}).strict();

const TunnelSchema = z.object({
  via: z.string().min(1),
  instance: z.string().min(1),
  reach: z.enum(["private", "public"]),
  domain: z.string().min(1).optional(),
  /** Default gate for this tunnel's routes. A public route must end up with one, or say `none`. */
  gate: Gate.optional(),
  /** Address (in the provider's terms: a port, a name under the domain) → service. */
  routes: z.record(z.string(), RouteSchema).default({}),
}).strict();

const HostingConfigSchema = z.object({
  local: LocalSchema.optional(),
  tunnels: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "tunnel names are lowercase words"), TunnelSchema).default({}),
}).strict();

export type HostingGate = z.infer<typeof Gate>;

export interface LocalConfig {
  via: string;
  domain: string;
  root?: string;
  services: "all" | string[];
  rename: Record<string, string>;
}

export interface TunnelConfig {
  via: string;
  instance: string;
  reach: "private" | "public";
  domain?: string;
  gate?: HostingGate;
  routes: Array<{ address: string; service: string; gate?: HostingGate }>;
}

export interface HostingConfig {
  local?: LocalConfig;
  tunnels: Record<string, TunnelConfig>;
}

export function hostingConfigPath(): string {
  return join(barryConfigDir(), "hosting.yaml");
}

/** Parse and validate the config's shape. Throws naming the offending key. */
export function parseHostingConfig(text: string, label = "hosting.yaml"): HostingConfig {
  const result = HostingConfigSchema.safeParse(parse(text) ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${label}: ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
  }
  const raw = result.data;
  const tunnels: Record<string, TunnelConfig> = {};
  for (const [name, t] of Object.entries(raw.tunnels)) {
    tunnels[name] = {
      via: t.via,
      instance: t.instance,
      reach: t.reach,
      ...(t.domain ? { domain: t.domain } : {}),
      ...(t.gate ? { gate: t.gate } : {}),
      routes: Object.entries(t.routes).map(([address, route]) =>
        typeof route === "string" ? { address, service: route } : { address, service: route.service, ...(route.gate ? { gate: route.gate } : {}) },
      ),
    };
  }
  return { ...(raw.local ? { local: raw.local } : {}), tunnels };
}

/** The installation's config, or null when it has none: then nothing is exposed beyond loopback. */
export function readHostingConfig(path = hostingConfigPath()): HostingConfig | null {
  if (!existsSync(path)) return null;
  return parseHostingConfig(readFileSync(path, "utf8"), path);
}
export const loadHostingConfig = readHostingConfig;
