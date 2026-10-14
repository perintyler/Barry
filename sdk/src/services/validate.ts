/**
 * Environment variable validation.
 *
 * Services call `validateEnv()` at startup to fail fast on missing config.
 */

export interface EnvRule {
  /** Environment variable name */
  name: string;
  /** Whether a service refuses to start without it. */
  required: "always" | "optional";
  /** Human-readable description (for error messages) */
  description: string;
  /** Services that consume this value directly. */
  services: BarryService[];
}

export type BarryService = "web" | "api" | "mcp" | "github-app";

/**
 * Startup validation rules and documented optional transport settings.
 * Required entries block startup when absent; optional entries do not.
 * This catalog does not enumerate every environment variable the repository reads.
 * See docs/decisions/0046-instance-service-and-event-comments.md.
 */
export const ENV_RULES: EnvRule[] = [
  // Core
  { name: "BARRY_SECRET",             required: "always",   description: "API secret for service auth", services: ["web", "api", "mcp", "github-app"] },

  // Transport. Optional because each has a working default; listed so their
  // meaning is written down rather than left to a grep for the name.
  { name: "BARRY_NAMESPACE_SPLIT",    required: "optional", description: "1 or true serves a session's tools as one MCP server per namespace; unset keeps a single server", services: [] },
  { name: "VAULT_URL",                required: "optional", description: "Vault server the CLI talks to; defaults to the local unix socket", services: [] },

  // Ingress
  { name: "BARRY_TRUST_PROXY",        required: "optional", description: "Trust X-Forwarded-* headers — only behind a proxy that sets them", services: ["api", "web"] },
  { name: "BARRY_CORS_ORIGINS",       required: "optional", description: "Comma-separated origins allowed to call the API", services: ["api"] },

  // Integrations
  { name: "MAILGUN_MAX_AGE_SECONDS",  required: "optional", description: "How old a Mailgun webhook signature may be", services: ["api"] },

  // Services
];

export interface ValidationResult {
  ok: boolean;
  missing: { name: string; description: string }[];
}

/**
 * Validate that every required env var is set.
 * Call at service startup for fail-fast behavior.
 *
 * @returns ValidationResult naming what is missing
 */
export function validateEnv(options?: { service?: BarryService }): ValidationResult {
  const missing: ValidationResult["missing"] = [];

  for (const rule of ENV_RULES) {
    if (options?.service && !rule.services.includes(options.service)) continue;
    if (rule.required !== "always") continue;

    const value = process.env[rule.name];
    if (!value || value.trim() === "") missing.push({ name: rule.name, description: rule.description });
  }

  return { ok: missing.length === 0, missing };
}
