import { existsSync } from "node:fs";
import { readServiceRegistry, serviceRegistryPath } from "./service-registry.js";
import { getServiceUrl, MCP_SERVER_KEY } from "./config.js";
import type { ConnectOptions } from "../index.js";
import { validateCredentials } from "../client/credentials.js";
import { installationSecrets } from "./installation-secrets.js";

/** Connect through the selected instance's registry and installation credential references. */
export async function localConnection(options: ConnectOptions = {}): Promise<ConnectOptions> {
  validateCredentials(options);
  const secret = options.resolveCredential ? undefined
    : options.secret ?? (await installationSecrets(["BARRY_SECRET"], { allowUnconfiguredInstance: true })).BARRY_SECRET;
  const resources: Readonly<Record<string, { url?: string }>> = (options.identities && options.services)
    || !existsSync(serviceRegistryPath()) ? {} : readServiceRegistry().resources;
  // Identity administration and service control each answer on their own service, with the same credential.
  const separate = (url: string | undefined) => url ? {
    baseUrl: url, secret, resolveCredential: options.resolveCredential,
    timeoutMs: options.timeoutMs, fetch: options.fetch,
  } : undefined;
  return {
    ...options,
    baseUrl: options.baseUrl ?? getServiceUrl("api"),
    secret,
    identities: options.identities ?? separate(resources["identities.identities"]?.url),
    services: options.services ?? separate(resources[MCP_SERVER_KEY]?.url),
  };
}
