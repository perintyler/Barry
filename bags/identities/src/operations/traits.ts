/**
 * Traits, for the processes hosting this bag: the terminal and the services
 * act with the installation's authority, and the HTTP routes admit only the
 * owner to trait writes. A caller asking on someone's behalf reads traits
 * through `Barry.traits()` and `Barry.identity(ref).traits()`.
 */
import {
  ALWAYS_ON_SERVERS,
  Traits,
  type EnsureTraitInput,
  type EnsureTraitsOptions,
} from "../config/traits.js";
import { findShellessIdentities } from "../config/trait-bound-validation.js";
import { listSelectableTraits } from "../selectable-traits.js";
import { resolveAndSyncBags } from "../store/identity-bags.js";

export const traits = {
  list: Traits.list,
  get: Traits.getByName,
  /** The traits of the installed bags, and the ones no installed bag owns any more. */
  installed: Traits.listInstalled,
  orphaned: Traits.findOrphaned,
  /** What the capability picker offers an identity. */
  selectable: listSelectableTraits,
  /** Identities whose selected traits leave no shell, for doctor. */
  shelless: findShellessIdentities,
  /** Servers every session reaches whatever its traits. */
  alwaysOn: ALWAYS_ON_SERVERS,
  /**
   * Resolve bag names against the registry, expand their composition, and
   * register the traits and bounds they declare. Strict refuses an unknown
   * name with `UnregisteredBagError`; otherwise it is a warning.
   */
  syncBags: resolveAndSyncBags,
  assertOwnership: Traits.assertOwnership,
  ensure: (inputs: EnsureTraitInput[], options: EnsureTraitsOptions) => Traits.ensureTraits(inputs, options),
  upsert: (trait: Parameters<typeof Traits.upsertTrait>[0]) => Traits.upsertTrait(trait),
  remove: (name: string): Promise<boolean> => Traits.deleteCustom(name),
};
