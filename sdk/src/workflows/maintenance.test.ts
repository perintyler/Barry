import { expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowOwner, WorkflowMaintenance } from "./index.js";

it("archives before automatic pruning, honors holds and refuses post-snapshot rows despite old timestamps", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-maintenance-")), database = join(root, "owner.db");
  let now = 1000;
  const owner = new WorkflowOwner({ id: "owner", path: database, now: () => now, definitions: [{ type: "done", version: "1", *run(input) { yield* []; return input; } }] });
  const start = (id: string) => owner.start({ id, type: "done", version: "1", input: null });
  start("archived"); start("held"); owner.retentionHold("held", true);
  now += 31 * 86_400_000;
  const maintenance = new WorkflowMaintenance({ owner, database, archiveDirectory: join(root, "archives"), artifacts: [], now: () => now });
  try {
    expect(maintenance.status()).toMatchObject({ scope: "owner-archive", executorStoresIncluded: false });
    maintenance.tick();
    expect(owner.get("archived").error).toBeNull();
    await expect.poll(() => maintenance.status().state, { timeout: 5000 }).toBe("ready");
    expect(readdirSync(join(root, "archives"))).toHaveLength(1);
    maintenance.tick();
    expect(owner.get("archived").error).toContain("RunArchived");
    expect(owner.get("held").error).toBeNull();
    now = 2000; start("not-in-archive"); now += 31 * 86_400_000;
    maintenance.tick();
    expect(owner.get("not-in-archive").error).toBeNull();
  } finally { await maintenance.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

it("preserves terminal data when archive verification fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-archive-failure-")), database = join(root, "owner.db");
  const owner = new WorkflowOwner({ id: "owner", path: database, now: () => 1000, activityArtifacts: { unavailable: "a".repeat(64) }, definitions: [{ type: "done", version: "1", *run(input) { yield* []; return input; } }] });
  owner.start({ id: "retained", type: "done", version: "1", input: null });
  const maintenance = new WorkflowMaintenance({ owner, database, archiveDirectory: join(root, "archives"), artifacts: [], now: () => 40 * 86_400_000 });
  try {
    maintenance.tick(); await expect.poll(() => maintenance.status().state, { timeout: 5000 }).toBe("archive_failed");
    maintenance.tick(); expect(owner.get("retained").error).toBeNull();
    expect(readdirSync(join(root, "archives"))).toHaveLength(0);
  } finally { await maintenance.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});
