/**
 * Entry point for sessions/search's recurring `embed` job, and its backfill.
 *
 * The sweep embeds through whatever models this process was started with, and
 * a bag may not name a vendor — so the job starts HERE, in sessions-api, a
 * declared composition root, and installs the models first. Bookkeeping's job
 * moved here for the same reason.
 *
 * Before this existed the sweep ran from its own bag, where nothing installed
 * a backend: every tick stopped as `model_unavailable` while the daemon was up
 * with the model pulled.
 */
import { createModels, installModels, assembleVendors, mergeVendorFactories } from "@barry-rocks/sdk/adapters/models";

import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { shippedVendorRows, selectedVendorFactories } from "../shipped-vendors.js";
import { runSweepAndReport } from "@barry-rocks/search-bag/sweep";

const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
const installedVendorCode = await installedAdapters.loadVendorCode();
installModels(
  createModels(
    assembleVendors([...(await shippedVendorRows()), ...installedAdapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories((await selectedVendorFactories()).factories, installedVendorCode.factories)),
  ),
);
await runSweepAndReport();
