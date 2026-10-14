/** Catalog data is independent of the model packages selected for this installation. */
import { registeredVendorRows, loadModelProviders } from "@barry-rocks/sdk/adapters/models";

import { barryModelProvidersPath } from "@barry-rocks/sdk/services";

export async function shippedVendorRows() { return registeredVendorRows(); }
export async function selectedVendorFactories() {
  return loadModelProviders({ file: barryModelProvidersPath() }).load();
}
