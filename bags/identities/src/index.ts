/**
 * The identities bag: its answer to `Barry`'s identities questions (the
 * `identities` subject a hosting process installs with `Barry.use`), and the
 * records, traits, bounds and access the processes hosting it act on with the
 * installation's authority. Storage is private; anything outside this bag
 * goes through these.
 */
export { bags } from "./operations/bags.js";
export { identities, identityOf, changesOf } from "./operations/identities.js";
export { identityRecords, nextDefaultIdentity, type IdentityEntry, type IdentityRef, type ResolvedSessionIdentity } from "./operations/identity-records.js";
export { traits } from "./operations/traits.js";
export { bounds } from "./operations/bounds.js";
export { access, owner } from "./operations/access.js";
export { store } from "./operations/store.js";
export type { IdentityRecord, IdentityMetadata, ResolvedIdentityConfig } from "./store/identities.js";
export type { UserRecord } from "./store/users.js";
export type { TraitInfo, EnsureTraitInput, EnsureTraitsOptions } from "./config/traits.js";
export type { BoundRecord } from "./config/bounds.js";
export type { InstallationOwnerRecord, InstallationOwnerSelection } from "./store/installation-owner.js";
export { UnregisteredBagError, type BagSyncWarning, type ResolveBagsResult } from "./store/identity-bags.js";
export { DevicePairingError, type DeviceRecord, type PairingInput, type PairingGrant, type PairingRequest, type PairingClaim } from "./devices.js";

export { isNumericIdentityName } from "./operations/identities.js";
