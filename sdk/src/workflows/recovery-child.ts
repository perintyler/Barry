import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import { createHash } from "node:crypto";
import { copyFileSync, writeFileSync, mkdirSync, renameSync, existsSync, mkdtempSync, rmSync, openSync, readSync, writeSync, closeSync, statSync, fsyncSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleWorkArtifacts, verifyWorkBundle } from "./work-artifact-recovery.js";
import { artifactAbi, verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import type { SnapshotManifest } from "./recovery.js";
import { migrations } from "./migrations.js";
import { readBoundedFile } from "./read-bounded.js";
import { runApprovalSchema } from "./approvals.js";
import { matchesApprovedFingerprint } from "../bounds/workflow-bounds.js";
import { pauseRestoredRuns } from "./recovery-fence.js";
import { createBootstrapLogger } from "../logging/emit-bootstrap.js";

import { workRecoveryInventorySchema, freezeWorkRecovery, captureWorkRecovery, bundleExecutorArtifacts, restoreWorkRecovery, mergeWorkRecoveryArtifacts, checkWorkRecoveryCoverage, checkWorkRecoveryAssignments, type WorkRecoveryInventory, type WorkRecoveryManifest } from "./work-recovery.js";

const log = createBootstrapLogger("workflow-recovery");

let input = "";
process.stdin.on("data", (data: Buffer) => { input += data.toString(); if (input.length > 1_048_576) process.exit(1); });
process.stdin.on("end", () => { try { run(); } catch (error) { log.error("recovery.failed", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; } });
const digest = (path: string) => {
  const file = openSync(path, "r"), hash = createHash("sha256"), buffer = Buffer.alloc(65_536);
  try { let bytes: number; while ((bytes = readSync(file, buffer)) > 0) hash.update(buffer.subarray(0, bytes)); return hash.digest("hex"); }
  finally { closeSync(file); }
};
function syncTree(path: string): void {
  const directory = opendirSync(path);
  try {
    let entry;
    while ((entry = directory.readSync())) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) syncTree(child);
      else if (entry.isFile()) { const descriptor = openSync(child, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
      else throw new Error("recovery publication refuses non-regular files");
    }
  } finally { directory.closeSync(); }
  const descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function validate(db: DatabaseSync, owner: string): void {
  if (db.prepare("SELECT value FROM workflow_meta WHERE key='owner'").get()?.value !== owner) throw new Error("snapshot owner mismatch");
  if (db.prepare("SELECT value FROM workflow_meta WHERE key='format'").get()?.value !== "2") throw new Error("unsupported snapshot schema");
  if (db.prepare("PRAGMA user_version").get()?.user_version !== migrations.length) throw new Error("unsupported snapshot schema version");
  for (const [index, migration] of migrations.entries()) {
    const checksum = db.prepare("SELECT checksum FROM schema_migrations WHERE version=?").get(index + 1)?.checksum;
    if (checksum !== createHash("sha256").update(migration.sql).digest("hex")) throw new Error("snapshot migration checksum mismatch");
  }
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("snapshot integrity failure");
  if (db.prepare("SELECT 1 FROM workflow_runs r LEFT JOIN workflow_grants g ON g.run_id=r.id AND g.revision=r.grant_revision WHERE (r.grant_revision IS NOT NULL AND g.run_id IS NULL) OR (json_extract(r.request,'$.job') IS NOT NULL AND r.grant_revision IS NULL) LIMIT 1").get()) throw new Error("snapshot run grant reference failure");
  if (db.prepare("SELECT 1 FROM workflow_session_bindings b LEFT JOIN workflow_commands c ON c.run_id=b.run_id AND c.id=b.step_id WHERE c.id IS NULL LIMIT 1").get()) throw new Error("snapshot session step reference failure");
  for (const row of db.prepare("SELECT run_id,revision,evidence FROM workflow_grants").iterate()) {
    const grant = runApprovalSchema.parse(JSON.parse(String(row.evidence)));
    if (grant.revision !== row.revision || !matchesApprovedFingerprint(grant.scope)) throw new Error("snapshot grant evidence mismatch");
  }
  if (db.prepare("SELECT 1 FROM workflow_commands c LEFT JOIN workflow_attempts a ON a.token=c.token WHERE c.state='leased' AND (a.token IS NULL OR a.command_id<>c.id OR a.state<>'active') LIMIT 1").get()) throw new Error("snapshot attempt invariant failure");
  if (db.prepare("SELECT 1 FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE a.state='active' AND (c.state<>'leased' OR c.token IS NULL OR c.token<>a.token) LIMIT 1").get()) throw new Error("snapshot stale active attempt");
  if (db.prepare("SELECT 1 FROM workflow_runs r LEFT JOIN workflow_due d ON d.run_id=r.id WHERE r.status IN ('running','blocked') AND d.run_id IS NULL LIMIT 1").get()) throw new Error("snapshot missing durable wake-up");
  for (const pointer of ["$.definition.input.payloadRef", "$.outcome.value.payloadRef"]) {
    if (db.prepare("SELECT 1 FROM workflow_events e LEFT JOIN workflow_payloads p ON p.run_id=e.run_id AND p.id=json_extract(e.details,?) WHERE json_extract(e.details,?) IS NOT NULL AND p.id IS NULL LIMIT 1").get(pointer, pointer)) throw new Error("snapshot missing referenced payload");
  }
  for (const payload of db.prepare("SELECT id,value,bytes FROM workflow_payloads").iterate()) {
    const value = String(payload.value);
    if (createHash("sha256").update(value).digest("hex") !== payload.id || Buffer.byteLength(value) !== payload.bytes) throw new Error("snapshot payload checksum mismatch");
  }
}
function sessionDependencies(db: DatabaseSync, stage: string): NonNullable<SnapshotManifest["sessionDependencies"]> {
  const file = "session-dependencies.jsonl", handle = openSync(join(stage, file), "wx", 0o600), hash = createHash("sha256");
  let bytes = 0, entries = 0;
  try {
    for (const row of db.prepare("SELECT b.run_id runId,b.step_id stepId,b.session_id sessionId,b.turn_id turnId,b.state,r.owner ownerNode,json_extract(g.evidence,'$.scope.identity') identity FROM workflow_session_bindings b JOIN workflow_runs r ON r.id=b.run_id JOIN workflow_grants g ON g.run_id=r.id AND g.revision=r.grant_revision ORDER BY b.run_id,b.step_id").iterate()) {
      const line = Buffer.from(JSON.stringify(row) + "\n");
      let offset = 0;
      while (offset < line.length) offset += writeSync(handle, line, offset, line.length - offset);
      hash.update(line); bytes += line.length; entries++;
    }
  } finally { closeSync(handle); }
  return { kind: "references-only", file, digest: hash.digest("hex"), bytes, entries };
}
function run(): void {
  const request = JSON.parse(input) as { operation: "snapshot" | "restore"; path: string; snapshot: string; destination: string; owner: string; artifacts: WorkflowArtifact[]; workArtifactRoot?: string; workRecovery?: WorkRecoveryInventory; oldExecutorsFenced?: boolean };
  if (existsSync(request.destination)) throw new Error("destination exists; refusing overwrite");
  mkdirSync(dirname(request.destination), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(request.destination), ".workflow-recovery-"));
  try {
    const target = join(stage, "workflows.db");
    let manifest: SnapshotManifest;
    if (request.operation === "snapshot") {
      const createdAt = new Date().toISOString();
      const inventory = request.workRecovery === undefined ? undefined : workRecoveryInventorySchema.parse(request.workRecovery);
      const unfreeze = inventory ? freezeWorkRecovery(request.path, inventory) : () => {};
      let workRecovery: WorkRecoveryManifest | undefined;
      try {
        const source = new DatabaseSync(request.path, { readOnly: true });
        try { validate(source, request.owner); if (inventory) checkWorkRecoveryCoverage(source, inventory); source.prepare("VACUUM INTO ?").run(target); } finally { source.close(); }
        if (inventory) {
          workRecovery = captureWorkRecovery(inventory, stage);
          const ownerCopy = new DatabaseSync(target, { readOnly: true });
          try { checkWorkRecoveryAssignments(ownerCopy, workRecovery, stage); } finally { ownerCopy.close(); }
        }
      } finally { unfreeze(); }
      if (inventory && workRecovery) bundleExecutorArtifacts(workRecovery, inventory, stage);
      const snapshot = new DatabaseSync(target, { readOnly: true });
      try {
        validate(snapshot, request.owner);
        const needed = snapshot.prepare("SELECT artifact FROM workflow_runs WHERE artifact IS NOT NULL UNION SELECT digest artifact FROM workflow_artifacts").all().map(row => String(row.artifact));
        for (const hash of needed) if (!request.artifacts.some(artifact => artifact.digest === hash)) throw new Error("snapshot is missing a pinned artifact");
        manifest = { format: 1, abi: artifactAbi, owner: request.owner, epoch: String(snapshot.prepare("SELECT value FROM workflow_meta WHERE key='epoch'").get()?.value), createdAt: workRecovery?.captured_at ?? createdAt, databaseDigest: digest(target), artifacts: [], ...(workRecovery ? { workRecovery } : {}) };
        manifest.sessionDependencies = sessionDependencies(snapshot, stage);
        manifest.workArtifacts = bundleWorkArtifacts(snapshot, request.workArtifactRoot, stage, request.owner);
      } finally { snapshot.close(); }
      for (const artifact of request.artifacts) {
        verifyArtifact(artifact);
        const file = `${artifact.digest}.mjs`;
        copyFileSync(artifact.path, join(stage, file));
        if (digest(join(stage, file)) !== artifact.digest) throw new Error("artifact changed during snapshot");
        manifest.artifacts.push({ type: artifact.type, version: artifact.version, digest: artifact.digest, file, ...(artifact.kind === "program" ? { kind: artifact.kind, bytes: artifact.bytes } : {}) });
      }
    } else {
      manifest = JSON.parse(readBoundedFile(join(request.snapshot, "manifest.json"), 1_048_576).toString("utf8")) as SnapshotManifest;
      if (manifest.format !== 1 || manifest.abi !== artifactAbi || manifest.owner !== request.owner || digest(join(request.snapshot, "workflows.db")) !== manifest.databaseDigest) throw new Error("snapshot manifest or database checksum mismatch");
      if (manifest.workRecovery && !request.oldExecutorsFenced) throw new Error("all old executor and resource effect paths must be fenced before coordinated restore");
      if (manifest.workRecovery) manifest.workRecovery = restoreWorkRecovery(manifest.workRecovery, request.snapshot, stage);
      copyFileSync(join(request.snapshot, "workflows.db"), target);
      if (digest(target) !== manifest.databaseDigest) throw new Error("snapshot database changed during restore");
      for (const artifact of manifest.artifacts) {
        if (!/^[a-f0-9]{64}\.mjs$/.test(artifact.file) || digest(join(request.snapshot, artifact.file)) !== artifact.digest) throw new Error("snapshot artifact checksum mismatch");
        if (artifact.kind !== undefined && artifact.kind !== "program" || artifact.bytes !== undefined && artifact.kind !== "program" || artifact.kind === "program" &&
          (!Number.isSafeInteger(artifact.bytes) || artifact.bytes! < 0 || artifact.bytes! > 536870912 || statSync(join(request.snapshot, artifact.file)).size !== artifact.bytes)) throw new Error("snapshot program artifact metadata mismatch");
        copyFileSync(join(request.snapshot, artifact.file), join(stage, artifact.file));
        if (digest(join(stage, artifact.file)) !== artifact.digest) throw new Error("snapshot artifact changed during restore");
      }
      const db = new DatabaseSync(target);
      try {
        validate(db, request.owner);
        if (manifest.workRecovery) { checkWorkRecoveryCoverage(db, manifest.workRecovery); checkWorkRecoveryAssignments(db, manifest.workRecovery, stage); }
        const dependencies = sessionDependencies(db, stage);
        if (manifest.sessionDependencies) {
          const recorded = manifest.sessionDependencies;
          if (recorded.kind !== "references-only" || recorded.file !== "session-dependencies.jsonl" || recorded.digest !== dependencies.digest || recorded.entries !== dependencies.entries || recorded.bytes !== dependencies.bytes || digest(join(request.snapshot, recorded.file)) !== recorded.digest || statSync(join(request.snapshot, recorded.file)).size !== recorded.bytes) throw new Error("snapshot session dependency evidence mismatch");
        } else if (dependencies.entries) throw new Error("snapshot is missing external session dependencies");
        manifest.sessionDependencies = dependencies;
        const workArtifacts = bundleWorkArtifacts(db, join(request.snapshot, "work-artifacts"), stage, request.owner);
        verifyWorkBundle(manifest.workArtifacts, workArtifacts);
        if (manifest.workArtifacts && (digest(join(request.snapshot, manifest.workArtifacts.file)) !== manifest.workArtifacts.digest || statSync(join(request.snapshot, manifest.workArtifacts.file)).size !== manifest.workArtifacts.bytes)) throw new Error("snapshot work artifact manifest checksum mismatch");
        for (const row of db.prepare("SELECT artifact digest FROM workflow_runs WHERE artifact IS NOT NULL UNION SELECT digest FROM workflow_artifacts").all()) if (!manifest.artifacts.some(artifact => artifact.digest === row.digest)) throw new Error("restored manifest is missing a pinned artifact");
        if (manifest.workRecovery) mergeWorkRecoveryArtifacts(manifest.workRecovery, stage, request.owner);
        manifest.epoch = pauseRestoredRuns(db, manifest.createdAt);
      } finally { db.close(); }
      manifest.databaseDigest = digest(target);
    }
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    syncTree(stage);
    renameSync(stage, request.destination);
    const parent = openSync(dirname(request.destination), "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    process.stdout.write(JSON.stringify(manifest));
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
