import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runArtifactMaintenance } from "./maintenance-job.js";
import { openLocalArtifactStore } from "./local/store.js";

it("maintains existing stores, reports missing stores and continues to other identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-job-"));
  try {
    const good = join(root, "good.db"), missing = join(root, "missing.db");
    const store = await openLocalArtifactStore({ node: "local", identity: "good", bag: "artifacts", store: "default", owned_by: "identity", engine: "sqlite", filepath: good });
    store.close();
    const reports = await runArtifactMaintenance([{ identity: "missing", path: missing }, { identity: "good", path: good }]);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ identity: "missing", error: expect.any(String) });
    expect(reports[1]).toMatchObject({ identity: "good", report: { failures: [] } });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = await openLocalArtifactStore({ node: "local", identity: "good", bag: "artifacts", store: "default", owned_by: "identity", engine: "sqlite", filepath: good }, { existingOnly: true });
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does no work and creates no catalog when the installation has no active artifact stores", async () => {
  expect(await runArtifactMaintenance([])).toEqual([]);
});
