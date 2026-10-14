/**
 * Entry point for the sessions bag's recurring `bookkeeping` job.
 *
 * Bookkeeping runs a local model over transcripts, and the sessions bag reaches
 * it through the installed models rather than naming a vendor — a bag that
 * imports an implementation pins everyone who installs it to that vendor. The
 * process that starts is the one entitled to choose, so the job starts HERE,
 * in sessions-api, a declared composition root (check:bag-host-reach), and
 * installs the models before the sweep asks for one.
 *
 * Before this existed the job ran session-bag's own bookkeeping.ts, which
 * nothing had installed a resolver for, and every tick died with "No LLM
 * resolver installed".
 */
import { createModels, installModels, assembleVendors, mergeVendorFactories } from "@barry-rocks/sdk/adapters/models";

import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { shippedVendorRows, selectedVendorFactories } from "../shipped-vendors.js";
import { runSweepAndReport } from "@barry-rocks/sessions-bag/bookkeeping";

const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
const installedVendorCode = await installedAdapters.loadVendorCode();
installModels(
  createModels(
    assembleVendors([...(await shippedVendorRows()), ...installedAdapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories((await selectedVendorFactories()).factories, installedVendorCode.factories)),
  ),
);
await runSweepAndReport();
