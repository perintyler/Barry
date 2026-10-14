import { defaultHarness, FALLBACK_HARNESS, type IdentityBagConfiguration } from "@barry-rocks/sdk/internal/identities";
import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { currentScope } from "./scope.js";
import { Barry } from "@barry-rocks/sdk";
import { identityRecords, traits } from "@barry-rocks/identities-bag";
import { assertToolAllowed, expandTraitNames, qualifyToolId, type ExecutionContext } from "@barry-rocks/sdk/bounds";
import type { ToolDefinition } from "@barry-rocks/sdk/tools";

/** Direct CLI tools obey the same identity policy as session tools before secrets or effects. */
export async function authorizeIdentityTool(tool: Pick<ToolDefinition, "name" | "namespace" | "access">): Promise<ExecutionContext & { node: string; bagConfigurations: Record<string, IdentityBagConfiguration> }> {
  const scope = currentScope();
  if (scope.kind !== "identity") throw new Error("tool invocation requires a generated identity CLI");
  const identity = await identityRecords.row(scope.binding.id);
  if (!identity) throw new Error("identity no longer exists");
  const config = identityRecords.config(identity);
  const requested = defaultHarness(config.adapters) ?? FALLBACK_HARNESS;
  const harness = findInstalled(loadAdapters({ file: barryAdaptersPath() }).installed(), requested)?.id ?? requested;
  const granted = await Barry.identity(identity.id).grants({ harness });
  // An execution context names its traits expanded, as every scope derived from it does.
  const traitsByName = Object.fromEntries((await traits.list()).map(row => [row.name, row]));
  const context: ExecutionContext = {
    identity: identity.name,
    traits: expandTraitNames(granted.traits, traitsByName, harness),
    bound: granted.bound,
    allowedToolIds: granted.tools.map(({ namespace, name }) => qualifyToolId(namespace, name)),
    harness,
  };
  assertToolAllowed(context, { namespace: tool.namespace, toolName: tool.name }, "local");
  const registry = new NodeRegistry();
  try {
    return { ...context, bagConfigurations: config.bag_configs, node: registry.id, identity: registry.identityId(identity.id) };
  } finally {
    registry.close();
  }
}
