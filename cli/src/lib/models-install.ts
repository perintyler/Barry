/**
 * Install this process's models exactly once.
 *
 * The CLI's preAction hook installs for identity-scope invocations; commands
 * that read the catalog at system scope (doctor) call this directly, because
 * that scope must not pay for adapter loading on every command. Idempotent:
 * whatever the entry point already installed stays.
 */
import { createModels, installModels, installedModels, assembleVendors, mergeVendorFactories } from "@barry-rocks/sdk/adapters/models";

import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { shippedVendorRows, selectedVendorFactories } from "./shipped-vendors.js";

export async function ensureModelsInstalled(): Promise<void> {
  try {
    installedModels();
    return;
  } catch {
    // Nothing installed yet — this process is the one that must install.
  }
  const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
  const installedVendorCode = await installedAdapters.loadVendorCode();
  for (const [id, problems] of installedVendorCode.refused) {
    console.error(`[barry] vendor code from adapter "${id}" did not load: ${problems.join("; ")}`);
  }
  installModels(
    createModels(
      assembleVendors([...(await shippedVendorRows()), ...installedAdapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories(await selectedVendorFactories(), installedVendorCode.factories)),
    ),
  );
}
