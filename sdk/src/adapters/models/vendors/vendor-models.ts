import { loadBagSync } from "../../../bags/loader.js";
import { loadRegistry, loadBuiltinRegistry } from "../../../bags/registry.js";
import { parseManifest, findManifest } from "../../../bags/manifest.js";
import { getRegistrySnapshotPath } from "../../../bags/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateVendorModels } from "./models.js";
import { SHIPPED_MODELS } from "./shipped-models.js";
import type { Vendor } from "./index.js";
import type { BagRegistry } from "../../../bags/types.js";
import { resolveBagAccess } from "../../../bags/types.js";

export type VendorModelList = Vendor[];

/** Catalogs are installed declarations, independent of identity packing. */
export function registeredVendorRows(
  registry?: BagRegistry,
  includeShipped: boolean = registry === undefined,
): Vendor[] {
  const cachedRegistry = registry === undefined && existsSync(getRegistrySnapshotPath());
  const reg = registry ?? (cachedRegistry ? loadRegistry() : loadBuiltinRegistry());
  const bagVendors: Vendor[] = [];
  for (const [name, source] of Object.entries(reg)) {
    if (source.type !== "local" || resolveBagAccess(source) === "disabled") continue;
    if (cachedRegistry) {
      // Composition already hydrated these validated manifests during launch.
      // Explicit registry callers retain the strict uncached parser below.
      const bag = loadBagSync(name);
      if (bag?.manifest) {
        if (!bag.manifest.vendors?.length) continue;
        if (bag.manifest.name !== name) throw new Error(`registered catalog bag ${name} declares a different name: ${bag.manifest.name}`);
        bagVendors.push(...bag.manifest.vendors);
        continue;
      }
    }
    const file = findManifest(source.path);
    if (!file) continue;
    const raw: unknown = parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !("vendors" in raw)) continue;
    const manifest = parseManifest(source.path);
    if (!manifest) throw new Error(`registered catalog bag ${name} has no manifest at ${source.path}`);
    if (manifest.name !== name) throw new Error(`registered catalog bag ${name} declares a different name: ${manifest.name}`);
    bagVendors.push(...(manifest.vendors ?? []));
  }
  validateVendorModels(bagVendors, !includeShipped);

  if (!includeShipped) {
    return validateVendorModels(bagVendors);
  }

  const bagVendorIds = new Set(bagVendors.map((v) => v.id));
  const merged = [...SHIPPED_MODELS.filter((v) => !bagVendorIds.has(v.id)), ...bagVendors];
  return validateVendorModels(merged);
}
