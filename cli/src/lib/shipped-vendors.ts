/** Shipped vendor rows are independent of the model packages selected for this installation. */
import { registeredVendorRows, loadModelVendors } from "@barry-rocks/sdk/adapters/models";

import { barryModelVendorsPath } from "@barry-rocks/sdk/services";

export async function shippedVendorRows() { return registeredVendorRows(); }
export async function selectedVendorFactories() {
  return loadModelVendors({ file: barryModelVendorsPath() }).load();
}
