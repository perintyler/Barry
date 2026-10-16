/** S1-P1/P2/P3/P4 source-review boundaries. Not installed capture/restore acceptance. */
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backedUpDataStores, discoverDataEvidence } from "./db-stores.js";
import { diagnoseWorkOps } from "./work-ops-diagnostics.js";
import { hashOpsFile, inventoryWorkOps, verifyWorkOpsFiles } from "./work-ops.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-ops-boundaries-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const rootSpec = (id: string, path: string, role: "worker" | "artifact" | "runtime") => ({
  id,
  path,
  role,
  owner: "fixture-owner",
  bindings: ["fixture-owner", "host-broker", "endpoint-broker"],
});
const inventory = (roots: ReturnType<typeof rootSpec>[]) => ({
  version: 1,
  roots,
  credentials: [],
});

it("S1-P1: explicitly observes configured worker paths outside the bag-data tree and a separate Work CAS", () => {
  const home = directory(),
    external = directory();
  // Layout matches workflow-work-worker.ts: config.directory is arbitrary;
  // authority/accepted-work.sqlite is not under workflow-authorities.
  // This is a path fixture, not a running/provisioned Sessions worker.
  const configured = {
    directory: join(external, "selected-worker"),
    artifact_root: join(home, "data", "workflows", "work-artifacts"),
  };
  mkdirSync(join(configured.directory, "authority"), { recursive: true });
  mkdirSync(configured.artifact_root, { recursive: true });
  for (const path of [
    join(configured.directory, "executor.sqlite"),
    join(configured.directory, "worker-lock.sqlite"),
    join(configured.directory, "authority", "accepted-work.sqlite"),
  ]) {
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE retained(value TEXT)");
    } finally {
      db.close();
    }
  }
  writeFileSync(join(configured.artifact_root, "agentArtifact"), "accepted agent bytes");
  const report = inventoryWorkOps(
    inventory([
      rootSpec("configured-worker", configured.directory, "worker"),
      rootSpec("work-cas", configured.artifact_root, "artifact"),
    ]),
  );
  expect(report.files.map((file) => `${file.root}/${file.path}`)).toEqual(
    expect.arrayContaining([
      "configured-worker/executor.sqlite",
      "configured-worker/worker-lock.sqlite",
      "configured-worker/authority/accepted-work.sqlite",
      "work-cas/agentArtifact",
    ]),
  );
  expect(report.complete).toBe(false);
  // Omission cannot become a complete inventory even if every supplied root is readable.
  const omitted = inventoryWorkOps(
    inventory([rootSpec("work-cas", configured.artifact_root, "artifact")]),
  );
  expect(omitted.complete).toBe(false);
  expect(omitted.blockers).toContain("ConfiguredRootsAreNotAuthoritativeDiscovery");
});

it.each(["root", "ancestor"])(
  "S1-P3: refuses an evidence %s symlink without enumerating its private target",
  (position) => {
    const root = directory(),
      outside = directory();
    writeFileSync(join(outside, "private-canary"), "PRIVATE_BYTES");
    const evidence = join(root, "evidence");
    if (position === "root") symlinkSync(outside, evidence);
    else {
      mkdirSync(join(outside, "nested"));
      writeFileSync(join(outside, "nested", "private-canary"), "PRIVATE_BYTES");
      symlinkSync(outside, join(root, "alias"));
    }
    const selected = position === "root" ? evidence : join(root, "alias", "nested");
    const report = inventoryWorkOps(inventory([rootSpec("evidence", selected, "artifact")]));
    expect(report.files).toEqual([]);
    expect(report.issues).toEqual([{ code: "RootUnavailableOrUnsafe", root: "evidence" }]);
    expect(JSON.stringify(report)).not.toContain("private-canary");
    expect(readFileSync(join(outside, "private-canary"), "utf8")).toBe("PRIVATE_BYTES");
    expect(() =>
      verifyWorkOpsFiles(selected, {
        version: 1,
        scope: "local-file-verification",
        members: [{ path: "private-canary", ...hashOpsFile(join(outside, "private-canary")) }],
      }),
    ).toThrow("UnsafeBackupRoot");

    // Also verify db-stores.ts discoverDataEvidence and backedUpDataStores refuse symlinked DATA_EVIDENCE_TREES at root or ancestor.
    const dataRoot = join(root, "data");
    const backupDir = join(root, "backup");
    if (position === "root") {
      mkdirSync(join(dataRoot, "sessions", "workflow-runtimes"), { recursive: true });
      symlinkSync(outside, join(dataRoot, "sessions", "workflow-runtimes", "artifacts"));
      mkdirSync(join(backupDir, "unmanaged", "data", "sessions", "workflow-runtimes"), {
        recursive: true,
      });
      symlinkSync(
        outside,
        join(backupDir, "unmanaged", "data", "sessions", "workflow-runtimes", "artifacts"),
      );
    } else {
      mkdirSync(join(outside, "artifacts"), { recursive: true });
      writeFileSync(join(outside, "artifacts", "private-canary"), "PRIVATE_BYTES");
      mkdirSync(join(dataRoot, "sessions"), { recursive: true });
      symlinkSync(outside, join(dataRoot, "sessions", "workflow-runtimes"));
      mkdirSync(join(backupDir, "unmanaged", "data", "sessions"), { recursive: true });
      symlinkSync(outside, join(backupDir, "unmanaged", "data", "sessions", "workflow-runtimes"));
    }
    expect(discoverDataEvidence(dataRoot)).toEqual([]);
    expect(backedUpDataStores(backupDir)).toEqual([]);
  },
);

it("S1-P2: a correct old member list cannot certify a registry changed after evidence enumeration", () => {
  const root = directory(),
    runtime = join(root, "runtime");
  mkdirSync(runtime);
  const oldArtifact = join(runtime, "old-artifact");
  writeFileSync(oldArtifact, "old closure");
  const enumerated = {
    version: 1,
    scope: "local-file-verification",
    members: [{ path: "old-artifact", ...hashOpsFile(oldArtifact) }],
  };
  const db = new Database(join(runtime, "generations.db"));
  try {
    db.exec(
      "CREATE TABLE workflow_runtime_generations(generation TEXT, artifact TEXT); INSERT INTO workflow_runtime_generations VALUES('later-generation','missing-later-artifact')",
    );
  } finally {
    db.close();
  }
  // The byte verifier intentionally does not inspect registry references. It
  // must keep capture/closure blocked even when the stale list verifies.
  const report = verifyWorkOpsFiles(runtime, enumerated);
  expect(report.filesVerified).toBe(true);
  expect(report.complete).toBe(false);
  expect(report.restoreReady).toBe(false);
  expect(report.recoveryPoint).toBeNull();
  expect(report.blockers).toContain("MemberListIsNotCustodyClosure");
});

it("S1-P4: an incompatible version-zero registry is reported without adopting or changing its schema", () => {
  const root = directory(),
    path = join(root, "legacy.db"),
    db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE workflow_runtime_generations(unrelated TEXT); INSERT INTO workflow_runtime_generations VALUES('retained legacy bytes')",
    );
  } finally {
    db.close();
  }
  const before = readFileSync(path),
    hash = hashOpsFile(path).sha256;
  const report = diagnoseWorkOps(path, hash, "runtime");
  expect(report.schemaVersion).toBe(0);
  expect(report.issues).toContain("UnsupportedSchema:generations");
  expect(report.complete).toBe(false);
  expect(report.restoreReady).toBe(false);
  expect(readFileSync(path)).toEqual(before);
});
