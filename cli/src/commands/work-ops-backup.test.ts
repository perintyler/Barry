/** Production managed backup path; observed-current coverage is not restore acceptance. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupManagedStores } from "./db-stores.js";
import { directory, sourceHome } from "./__tests__/db-home.js";
import { inventoryWorkOps, verifyWorkOpsFiles } from "./work-ops.js";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";

it("does not certify generic managed backup output as a complete Work/Sessions recovery bundle", async () => {
  await sourceHome();
  const runtime = join(barryAppSupportDir(), "data", "sessions", "workflow-runtimes"); mkdirSync(runtime, { recursive: true });
  const db = new DatabaseSync(join(runtime, "generations.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE workflow_runtime_generations(generation TEXT); INSERT INTO workflow_runtime_generations VALUES('retained')");
    const destination = join(directory("work-ops-backup-"), "backup"); mkdirSync(destination);
    const lines = await backupManagedStores(destination);
    expect(lines.some(line => line.includes("stores/"))).toBe(true);
    // Observe known provisioned roots, avoiding materialized runtime/package traversal.
    const result = inventoryWorkOps({ version: 1, roots: [{ id: "runtime", path: realpathSync(runtime), role: "runtime", owner: "fixture", bindings: ["sessions"] }], credentials: [] });
    expect(result.files.some(file => file.kind === "wal")).toBe(true);
    expect(result.complete).toBe(false); expect(result.recoveryPoint).toBeNull();
    // Accepted agent bytes missing from an otherwise usable database backup must fail verification.
    const expected = { version: 1, scope: "local-file-verification", members: [{ path: "agentArtifact", bytes: 8, sha256: createHash("sha256").update("accepted").digest("hex") }] };
    expect(verifyWorkOpsFiles(realpathSync(destination), expected).filesVerified).toBe(false);
    expect(existsSync(join(runtime, "generations.db-wal"))).toBe(true);
  } finally { db.close(); }
});
