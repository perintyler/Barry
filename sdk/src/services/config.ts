import { serviceAddress } from "./service-registry.js";

/**
 * The short names callers use for core services. Every other service is looked up
 * by its own `<bag>.<service>` registry name. Ollama is not here: it is a
 * token vendor, and its address is the vendor's (registered bags’ vendor declarations).
 */
export type ServiceName = "api" | "mcpBarry" | "slack";
export { validateEnv, ENV_RULES } from "./validate.js";
export type { EnvRule, ValidationResult as EnvValidationResult } from "./validate.js";

/** Browser-origin policy is separate from authentication and installation hosting policy. */
export interface HostingConfig {
  /** Origins allowed besides localhost: `BARRY_CORS_ORIGINS`, comma-separated, `*` matching a port. */
  allowedOrigins: string[];
}

/**
 * Extra origins allowed by `BARRY_CORS_ORIGINS`, beyond localhost.
 *
 * Exported so a service can log what it actually allows at startup: CORS
 * failures show up in a browser as an opaque network error, and "localhost
 * only" in the boot log is usually the answer.
 */
export function corsOrigins(): string[] {
  const raw: string = process.env.BARRY_CORS_ORIGINS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getHostingConfig(): HostingConfig {
  return { allowedOrigins: corsOrigins() };
}

/**
 * The one origin matcher every service shares (SDK-21). A literal entry must
 * match exactly; a `*` is a PORT wildcard only — `http://host:*` escapes every
 * regex metacharacter and maps `*` to `\d+`, so the dots stay literal and the
 * wildcard cannot widen to another host. A drifted copy that mapped `*` to
 * `.*` with unescaped dots was quietly less protected while looking identical.
 */
export function originAllowed(origin: string, allowed: string): boolean {
  if (!allowed.includes("*")) return allowed === origin;
  const escaped = allowed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace("\\*", "\\d+");
  return new RegExp(`^${pattern}$`).test(origin);
}

/** The MCP server registry key; CLI compatibility aliases resolve separately. See docs/decisions/0046-instance-service-and-event-comments.md. */
export const MCP_SERVER_KEY = "mcp.server";

/** The registry name behind each short name. */
const REGISTRY_NAMES = {
  api: "sessions.api",
  mcpBarry: MCP_SERVER_KEY,
  slack: "slack-app.events",
} as const satisfies Record<ServiceName, string>;

/**
 * Where `service` listens, read from this instance's registry on every call.
 *
 * Per call rather than once at startup: a service moved with
 * `barry service port` is reached at its new address by the very next
 * request, and nothing that talks to it has to restart. The read costs a
 * `stat`. Throws when the service is not registered, rather than falling back
 * to a number that belongs to some other instance.
 */
export function getServiceUrl(service: ServiceName, host = "localhost"): string {
  const name = REGISTRY_NAMES[service];
  if (!name) throw new Error(`Unknown core service alias: ${service}`);
  const url = new URL(serviceAddress(name));
  // Services bind loopback, so the one other spelling a caller means is `localhost`.
  if (host !== "localhost" && host !== "127.0.0.1") url.hostname = host;
  return url.origin;
}

/** The port `service` listens on now. See `getServiceUrl`. */
export function getServicePort(service: ServiceName): number {
  return Number(new URL(getServiceUrl(service)).port);
}
