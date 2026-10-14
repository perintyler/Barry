/**
 * The identities subject's `grants`, composed over the identities operations
 * a test mocks.
 *
 * A suite that mocks the identities bag at its root replaces
 * `identityRecords.row`, `identityRecords.config`, `traits.list` and
 * `bounds.get`, but the subject reads the bag's store, which those mocks never
 * reach. This hands the bag's own composition the mocked operations as its
 * readers: the store is synthetic, the composition is the real one. A suite
 * installs it as the subject: `Barry.use(fakeIdentities({ grants: grantsOver(store) }))`.
 */
import { BarryError, type Identities } from "@barry-rocks/sdk";
import type { ToolMeta } from "@barry-rocks/sdk/bounds";
import { sessionPolicyOver } from "@barry-rocks/identities-bag/testing";
import type { bounds as Bounds, identityRecords as IdentityRecords, traits as Traits } from "@barry-rocks/identities-bag";

export interface PolicyStore {
  identityRecords: Pick<typeof IdentityRecords, "row" | "config">;
  traits: Pick<typeof Traits, "list">;
  bounds: Pick<typeof Bounds, "stored">;
}

/**
 * Each read goes through `store` when it happens, so a test's
 * `mockResolvedValueOnce` reaches it. `tools` stands in for the tools the
 * registered bags declare, which the grants are decided over.
 */
export function grantsOver(store: PolicyStore, tools?: readonly ToolMeta[]): Identities["grants"] {
  const policy = sessionPolicyOver({
    identity: (id) => store.identityRecords.row(id),
    config: (identity) => store.identityRecords.config(identity),
    traits: () => store.traits.list(),
    bounds: () => store.bounds.stored(),
  });
  return async (ref, selection) => {
    // The store is keyed by row id, which is how a session names its identity.
    const identity = typeof ref === "number" ? await store.identityRecords.row(ref) : undefined;
    if (ref !== null && !identity) throw new BarryError("not_found", `Identity ${ref} not found`);
    try {
      return await policy.grants(identity, selection, tools);
    } catch (error) {
      throw new BarryError("invalid", error instanceof Error ? error.message : String(error));
    }
  };
}
