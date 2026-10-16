import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { barryConfigDir } from "@barry-rocks/sdk/services";
import { LiteralEnvSchema, normalizeLiteralEnv, type LiteralEnvValue } from "@barry-rocks/sdk/internal/services";

const configuration = z.object({
  services: z.record(z.string(), z.object({ env: LiteralEnvSchema.optional() }).strict()).optional(),
});

/** Installation overrides may replace declared literals, never add credential or launcher bindings. */
export function installationEnvironment(
  service: string,
  defaults: readonly LiteralEnvValue[],
  secrets: readonly string[] = [],
  configPath = join(barryConfigDir(), "barry.yaml"),
): LiteralEnvValue[] {
  const selected = configuration.parse(existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) : {});
  const overrides = normalizeLiteralEnv(selected.services?.[service]?.env ?? []);
  const values = new Map(defaults.map(entry => [entry.name, entry]));
  for (const entry of overrides) {
    if (!values.has(entry.name) || secrets.includes(entry.name)) {
      throw new Error(`${service}: installation environment override ${entry.name} is not a declared nonsecret value`);
    }
    // Hosted sessions use one aggregate MCP connection. Split is an identity choice.
    if (service === "sessions.api" && entry.name === "BARRY_NAMESPACE_SPLIT") continue;
    values.set(entry.name, entry);
  }
  return [...values.values()];
}
