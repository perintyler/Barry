import { identityStorePaths, type StoreBinding } from "@barry-rocks/sdk/stores";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLocalArtifactStore } from "./local/store.js";

/** Only existing active identity stores; never create a catalog for a job. */
export async function runArtifactMaintenance(
  paths = identityStorePaths("artifacts", "default"),
  open: typeof openLocalArtifactStore = binding => openLocalArtifactStore(binding, { existingOnly: true }),
) {
  const reports = [];
  for (const { identity, path } of paths) {
    const binding: StoreBinding = { node: "local", identity, bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath: path };
    try {
      const store = await open(binding);
      try { reports.push({ identity, report: store.maintenance.run() }); }
      finally { store.close(); }
    } catch (error) {
      reports.push({ identity, error: error instanceof Error ? error.message : "Maintenance unavailable" });
    }
  }
  return reports;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const reports = await runArtifactMaintenance();
  process.stdout.write(JSON.stringify(reports) + "\n");
  if (reports.some(report => "error" in report || ("report" in report && report.report.failures.length))) process.exitCode = 1;
}
