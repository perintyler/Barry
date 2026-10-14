import { Barry, isBarryError } from "@barry-rocks/sdk";
import { createRunAuthorization, createRunScopeRefresh, type RunPolicySources } from "@barry-rocks/sdk/internal/workflows";
import { collectToolMeta } from "@barry-rocks/sdk/internal/tools";
import { bounds, traits } from "@barry-rocks/identities-bag";
import type { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";

/** Concrete installation wiring stays in the application, outside standalone workflows. */
export function instanceRunAuthorization(peers: NodeRegistry) {
  return createRunAuthorization(instancePolicySources(peers));
}
export function instanceRunScopeRefresh(peers: NodeRegistry) {
  return createRunScopeRefresh(instancePolicySources(peers));
}
function instancePolicySources(peers: NodeRegistry): RunPolicySources {
  return {
    operator: principal => principal === "local-operator",
    mayRunAs: async (principal, identity) => principal === "local-operator" || identity === undefined || identity === principal,
    catalog: async () => ({ traits: Object.fromEntries((await traits.list()).map(trait => [trait.name, { ...trait }])), tools: await collectToolMeta() }),
    identity: async id => {
      try {
        // The identity's own restrictions, its named and inline bounds; its traits are the run's to select.
        const { bound } = await Barry.identity(peers.legacyIdentityId(id)).grants({ defaults: false, identityTraits: false });
        return { bound };
      } catch (error) {
        if (isBarryError(error) && error.reason === "not_found") return undefined;
        throw error;
      }
    },
    boundByName: async name => await bounds.get({ name }),
  };
}
