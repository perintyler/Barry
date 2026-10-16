/** Catalog data is independent of the model packages selected for this installation. */
import { registeredVendorRows, loadModelVendors } from "@barry-rocks/sdk/adapters/models";

import { barryModelVendorsPath } from "@barry-rocks/sdk/services";

export async function shippedVendorRows() { return registeredVendorRows(); }
export async function selectedVendorFactories() {
  const providers = loadModelVendors({ file: barryModelVendorsPath() });
  const factories = await providers.load();
  return { factories, refused: providers.refused };
}
