/**
 * Entry point for session-vector-search's recurring `embed` job, and its backfill.
 *
 * The sweep embeds through whatever models this process was started with, so
 * the job installs the configured model providers before running the sweep.
 */
import {
  createModels,
  installModels,
  assembleVendors,
  mergeVendorFactories,
  registeredVendorRows,
  loadModelVendors,
} from "@barry-rocks/sdk/adapters/models";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath, barryModelVendorsPath } from "@barry-rocks/sdk/services";
import { runSweepAndReport } from "../sweep.js";

const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
const installedVendorCode = await installedAdapters.loadVendorCode();
const providers = loadModelVendors({ file: barryModelVendorsPath() });
const providerFactories = await providers.load();

installModels(
  createModels(
    assembleVendors(
      [
        ...registeredVendorRows(),
        ...installedAdapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? []),
      ],
      mergeVendorFactories(providerFactories, installedVendorCode.factories),
    ),
  ),
);
await runSweepAndReport();
