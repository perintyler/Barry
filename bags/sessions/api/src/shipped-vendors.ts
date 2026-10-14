/** Catalog data is independent of the model packages selected for this installation. */
import { registeredVendorRows, loadModelProviders } from "@barry-rocks/sdk/adapters/models";

import { barryModelProvidersPath } from "@barry-rocks/sdk/services";

export async function shippedVendorRows() { return registeredVendorRows(); }
export async function selectedVendorFactories() {
  const providers = loadModelProviders({ file: barryModelProvidersPath() });
  const factories = await providers.load();
  return { factories, refused: providers.refused };
}
