export { openBagStore, openStoreFile, type BagStore, type BagStoreOptions, type StoreHandle } from "./open-bag-store.js";
export { migrateStore, type Migration, type MigrationResult, type MigratableDatabase } from "./migrate.js";
export { migratedStorePath, identityStorePaths, sessionIdentity, AmbiguousSessionLocation } from "./paths.js";
export type { StoreContext, StoreBagConfiguration } from "./context.js";
export { resolveStoreBinding, mergeStoreOptions, type StoreBinding, type StoreResolution, type StoreOptions } from "./bindings.js";
export { assertScratchStoreUnderTest } from "./scratch-guard.js";
export {
    StoreRegistry, storePath, storeKey, validateSnapshot, installSnapshot, copySnapshot, SnapshotManifestSchema,
    type RegistryStoreHandle, type StoreScope, type StoreRef, type StoreDeclaration, type StoreProvider,
    type SnapshotManifest, type StoreSnapshot, type StoreRestoreAdapter, type StoreSnapshotAdapter, type SnapshotResource,
} from "./registry.js";
