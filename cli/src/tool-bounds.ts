import { defaultHarness, FALLBACK_HARNESS, requiredIdentityBags, requiredNames, type IdentityBagConfiguration } from "@barry-rocks/sdk/internal/identities";
import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { currentTarget } from "./target.js";
import { Barry } from "@barry-rocks/sdk";
import { identityRecords } from "@barry-rocks/identities-bag";
import { assertToolAllowed, qualifyToolId, type ToolCallBounds } from "@barry-rocks/sdk/bounds";
import type { ToolDefinition } from "@barry-rocks/sdk/tools";

/** Direct CLI tools obey the same identity bounds as session tools before secrets or effects. */
export async function authorizeIdentityTool(tool: Pick<ToolDefinition, "name" | "namespace" | "access">): Promise<ToolCallBounds & { node: string; bagConfigurations: Record<string, IdentityBagConfiguration> }> {
  const target = currentTarget();
  if (target.kind !== "identity") throw new Error("tool invocation requires a generated identity CLI");
  const identity = await identityRecords.row(target.binding.id);
  if (!identity) throw new Error("identity no longer exists");
  const config = identityRecords.config(identity);
  const requested = defaultHarness(config.adapters) ?? FALLBACK_HARNESS;
  const harness = findInstalled(loadAdapters({ file: barryAdaptersPath() }).installed(), requested)?.id ?? requested;
  const [tools, bound] = await Promise.all([
    Barry.tools(identity.id, undefined),
    Barry.bound(identity.id, undefined),
  ]);
  const callerBounds: ToolCallBounds = {
    identity: identity.name,
    bags: requiredIdentityBags(config.bags ?? [], config.bag_configs ?? {}),
    bounds: requiredNames(config.bounds ?? []),
    bound,
    allowedToolIds: tools.map(({ namespace, name }) => qualifyToolId(namespace, name)),
    harness,
  };
  const registry = new NodeRegistry();
  try {
    assertToolAllowed(callerBounds, { namespace: tool.namespace, toolName: tool.name }, registry.id);
    return { ...callerBounds, bagConfigurations: config.bag_configs, node: registry.id, identity: registry.identityId(identity.id) };
  } finally {
    registry.close();
  }
}
