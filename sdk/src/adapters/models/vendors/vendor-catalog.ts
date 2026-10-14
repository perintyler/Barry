import { loadRegistry, loadBuiltinRegistry } from "../../../bags/registry.js";
import { parseManifest, findManifest } from "../../../bags/manifest.js";
import { getRegistrySnapshotPath } from "../../../bags/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateVendorCatalog } from "./catalog.js";
import { SHIPPED_VENDORS } from "./shipped-catalog.js";
import type { Vendor } from "./index.js";
import type { BagRegistry } from "../../../bags/types.js";
import { resolveBagAccess } from "../../../bags/types.js";

/** Catalogs are installed declarations, independent of identity packing. */
export function registeredVendorRows(
  registry?: BagRegistry,
  includeShipped: boolean = registry === undefined,
): Vendor[] {
  const reg = registry ?? (existsSync(getRegistrySnapshotPath()) ? loadRegistry() : loadBuiltinRegistry());
  const bagVendors: Vendor[] = [];
  for (const [name, source] of Object.entries(reg)) {
    if (source.type !== "local" || resolveBagAccess(source) === "disabled") continue;
    const file = findManifest(source.path);
    if (!file) continue;
    const raw: unknown = parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !("vendors" in raw)) continue;
    const manifest = parseManifest(source.path);
    if (!manifest) throw new Error(`registered catalog bag ${name} has no manifest at ${source.path}`);
    if (manifest.name !== name) throw new Error(`registered catalog bag ${name} declares a different name: ${manifest.name}`);
    bagVendors.push(...(manifest.vendors ?? []));
  }
  validateVendorCatalog(bagVendors, !includeShipped);

  if (!includeShipped) {
    return validateVendorCatalog(bagVendors);
  }

  const bagVendorIds = new Set(bagVendors.map((v) => v.id));
  const merged = [...SHIPPED_VENDORS.filter((v) => !bagVendorIds.has(v.id)), ...bagVendors];
  return validateVendorCatalog(merged);
}
