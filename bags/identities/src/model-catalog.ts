/**
 * What this bag knows about models: the vendor catalog and the installed
 * harnesses, handed in by the service entry point, which is the composition
 * root. A bag names no vendor, so it cannot load either itself.
 *
 * Only warnings read it — a default model or model provider is accepted on
 * write either way, and a session start is where an unroutable one is
 * refused. Unset, nothing is known and nothing is warned about.
 */
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { isOfferedModel } from "@barry-rocks/sdk/adapters/models";
import type { Vendor } from "@barry-rocks/sdk/adapters/models";

export interface ModelCatalog {
  vendors(): readonly Vendor[];
  harnesses(): readonly InstalledAdapter[];
}

let catalog: ModelCatalog | null = null;

export function setModelCatalog(next: ModelCatalog): void {
  catalog = next;
}

/** False when the harness is known and does not offer the model; true otherwise. */
export function isKnownModelFor(harness: string, model: string): boolean {
  const record = catalog ? findInstalled(catalog.harnesses(), harness) : undefined;
  return !catalog || !record || isOfferedModel(record, catalog.vendors(), model);
}

/** With no catalog, an id is accepted without a membership or mode warning. */
export function knownHarness(id: string): InstalledAdapter | { id: string; aliases?: readonly string[]; modes?: undefined } | undefined {
  return catalog ? findInstalled(catalog.harnesses(), id) : { id };
}
