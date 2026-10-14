/** Catalogs receive loaded bag data rather than importing the runtime loader. */

import type { BagSource } from "../bags/types.js";
import type { BagJob } from "../bags/job-manifest.js";

/** What a catalog needs to enumerate one bag's on-disk contributions. */
export interface BagCatalogEntry {
  /** Registry name — the `bag:` half of every qualified name. */
  readonly name: string;
  /** Only ever passed to `resolveBagAccess`. */
  readonly source: BagSource;
  readonly skillsDirs: readonly string[];
  readonly actionsDirs: readonly string[];
  readonly instructionsDirs: readonly string[];
  /**
   * Only `manifest.instructions` is read, and only for the deprecated
   * pre-primitive form. Shaped to match `Bag["manifest"]` (a full
   * `BagManifest | null`) so callers hand over a loaded bag untouched.
   */
  readonly manifest?: { readonly instructions?: string } | null;
  /** The bag's jobs: a `job:` action's contract is its job's. */
  readonly jobs?: ReadonlyArray<BagJob & { name: string; dir: string }>;
}
