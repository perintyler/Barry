/**
 * Entry point for the sessions bag's `summarize-sessions` job.
 *
 * A composition root for the reason bookkeeping is (see bookkeeping.ts): the
 * summary model is reached through the installed models, and only the process
 * that starts may choose them. Prints `{summarized, considered}` as its JSON
 * output; everything else goes to stderr.
 */
import { createModels, installModels, assembleVendors, mergeVendorFactories } from "@barry-rocks/sdk/adapters/models";

import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { shippedVendorRows, selectedVendorFactories } from "../shipped-vendors.js";
import { DEFAULT_MAX_SESSIONS, DEFAULT_QUIET_MS, summarizeQuietSessions } from "../session-summarizer.js";

const minutes = Number(process.env.BARRY_SUMMARY_QUIET_MIN);
const maxSessions = Number(process.env.BARRY_SUMMARY_MAX_SESSIONS);

const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
const installedVendorCode = await installedAdapters.loadVendorCode();
installModels(
  createModels(
    assembleVendors([...(await shippedVendorRows()), ...installedAdapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories((await selectedVendorFactories()).factories, installedVendorCode.factories)),
  ),
);
const result = await summarizeQuietSessions({
  quietMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_QUIET_MS,
  maxSessions: Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : DEFAULT_MAX_SESSIONS,
});
process.stdout.write(JSON.stringify({ summarized: result.summarized, considered: result.considered }));
process.exit(0);
