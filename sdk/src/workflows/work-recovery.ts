import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, mkdirSync, realpathSync, existsSync, linkSync, writeFileSync, chmodSync, lstatSync, copyFileSync } from "node:fs";
import { isAbsolute, join, dirname, basename } from "node:path";
import { z } from "zod";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { executionBindingSchema, executorObservationSchema, executorStartSchema, workArtifactSchema, stageReceiptSchema, workReceiptSchema } from "./work-contracts.js";
import { workTaskSchema } from "./protocol.js";
import { workReceiptDigest } from "./executor-journal.js";
import { workDelegationRecordSchema } from "./work-delegation.js";
import { workResourceRequestSchema } from "./work-resource-broker.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { readBoundedFile } from "./read-bounded.js";
import type { WorkArtifactRef } from "./work-artifacts.js";
const ref = z.string().min(1).max(200), id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().max(4096).refine(isAbsolute, "recovery paths must be absolute");
const component = z.discriminatedUnion("role", [
  z.strictObject({ id, role: z.literal("executor"), identity: ref, path: absolute, artifact_root: absolute, workers: z.array(ref).min(1).max(100) }),
  z.strictObject({ id, role: z.literal("issuer"), identity: ref, path: absolute }),
  z.strictObject({ id, role: z.literal("broker"), identity: ref, path: absolute }),
]);
export const workRecoveryInventorySchema = z.strictObject({ version: z.literal(1), components: z.array(component).min(2).max(32) }).superRefine((value, context) => {
  if (new Set(value.components.map(entry => entry.id)).size !== value.components.length || new Set(value.components.map(entry => entry.path)).size !== value.components.length)
    context.addIssue({ code: "custom", message: "recovery component IDs and database paths must be unique" });
  if (!value.components.some(entry => entry.role === "executor") || !value.components.some(entry => entry.role === "broker"))
    context.addIssue({ code: "custom", message: "work recovery requires executor and broker stores" });
});
export type WorkRecoveryInventory = z.infer<typeof workRecoveryInventorySchema>;
const capturedComponentSchema = z.strictObject({ id, role: z.enum(["executor", "issuer", "broker"]), identity: ref,
  workers: z.array(ref).max(100), digest: hash, bytes: z.number().int().nonnegative(),
  artifacts: z.strictObject({ digest: hash, bytes: z.number().int().nonnegative(), entries: z.number().int().nonnegative(), owner: ref.nullable() }).nullable() });
export const workRecoveryManifestSchema = z.strictObject({ version: z.literal(1), captured_at: z.string().datetime(),
  components: z.array(capturedComponentSchema).min(2).max(32), external_credentials: z.array(ref).max(32) }).refine(value => new Set(value.components.map(entry => entry.id)).size === value.components.length, "duplicate recovery component")
  .refine(value => value.components.some(entry => entry.role === "executor") && value.components.some(entry => entry.role === "broker"), "missing executor or broker component")
  .refine(value => value.components.every(entry => entry.role === "executor" ? entry.workers.length > 0 && entry.artifacts !== null : entry.workers.length === 0 && entry.artifacts === null), "invalid recovery component coverage")
  .refine(value => JSON.stringify([...value.external_credentials].sort()) === JSON.stringify(value.components.filter(entry => entry.role === "issuer").map(entry => entry.identity).sort()), "missing external credential reference");
export type WorkRecoveryManifest = z.infer<typeof workRecoveryManifestSchema>;
type Component = WorkRecoveryInventory["components"][number];
export function fileDigest(path: string): { digest: string; bytes: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), buffer = Buffer.alloc(65536), hash = createHash("sha256");
  try {
    const stat = fstatSync(fd); if (!stat.isFile()) throw new Error("recovery requires regular files");
    let count: number; while ((count = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
    return { digest: hash.digest("hex"), bytes: stat.size };
  } finally { closeSync(fd); }
}
function database(path: string, readOnly = true) {
  const canonical = join(realpathSync(dirname(path)), basename(path));
  if (realpathSync(path) !== canonical) throw new Error("recovery refuses symlink database paths");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe recovery database file"); }
  finally { closeSync(fd); }
  return new SqliteDatabase(canonical, { readOnly });
}
function validate(db: SqliteDatabase, entry: Pick<Component, "role" | "identity">) {
  const role = entry.role, versions = { executor: 5, issuer: 2, broker: 1 }, meta = { executor: ["executor_meta", "installation"], issuer: ["delegation_meta", "issuer"], broker: ["resource_meta", "broker"] };
  if (db.prepare("PRAGMA user_version").get()?.user_version !== versions[role] || db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("unsupported or corrupt work recovery database");
  const [table, column] = meta[role], rows = db.prepare(`SELECT ${column} identity FROM ${table}`).all();
  if (rows.length !== 1 || rows[0].identity !== entry.identity) throw new Error("work recovery component identity mismatch");
  if (role === "issuer") for (const row of db.prepare("SELECT * FROM delegation_records").iterate()) {
    const record = workDelegationRecordSchema.parse(JSON.parse(String(row.record)));
    if (record.issuer !== entry.identity || record.grant_ref !== row.grant_ref || record.request_hash !== row.request_hash || boundFingerprint(record) !== row.record_digest) throw new Error("issuer recovery evidence mismatch");
  }
  if (role === "issuer" && db.prepare("SELECT 1 FROM delegation_preparations p LEFT JOIN delegation_records r ON r.grant_ref=p.grant_ref WHERE r.grant_ref IS NULL LIMIT 1").get()) throw new Error("issuer recovery preparation is missing authority");
  if (role === "broker") for (const row of db.prepare("SELECT request,state FROM resource_reservations").iterate()) {
    workResourceRequestSchema.parse(JSON.parse(String(row.request)));
    if (!["held", "released"].includes(String(row.state))) throw new Error("invalid recovered reservation state");
  }
}
/** Freeze writers only while taking SQLite copies, before streaming immutable blobs. */
export function freezeWorkRecovery(ownerPath: string, inventory: WorkRecoveryInventory): () => void {
  const locked: SqliteDatabase[] = [];
  try {
    const paths = [ownerPath, ...inventory.components.map(entry => entry.path)];
    if (new Set(paths.map(path => realpathSync(path))).size !== paths.length) throw new Error("recovery databases must be distinct");
    for (const path of paths) {
      const db = database(path, false); locked.push(db); db.exec("PRAGMA busy_timeout=50; BEGIN IMMEDIATE");
    }
    return () => { for (const db of locked.reverse()) { try { db.exec("ROLLBACK"); } finally { db.close(); } } };
  } catch (error) { for (const db of locked.reverse()) { try { db.exec("ROLLBACK"); } catch { /* No lock acquired. */ } db.close(); } throw error; }
}
export function captureWorkRecovery(inventory: WorkRecoveryInventory, destination: string): WorkRecoveryManifest {
  mkdirSync(join(destination, "work-recovery"), { mode: 0o700 });
  const components = inventory.components.map(entry => {
    const path = join(destination, "work-recovery", `${entry.id}.db`), source = database(entry.path);
    try { validate(source, entry); source.prepare("VACUUM INTO ?").run(path); chmodSync(path, 0o600); } finally { source.close(); }
    const copied = database(path, false); try { copied.exec("PRAGMA journal_mode=DELETE"); validate(copied, entry); } finally { copied.close(); }
    return { id: entry.id, role: entry.role, identity: entry.identity, workers: entry.role === "executor" ? entry.workers : [], ...fileDigest(path), artifacts: null };
  });
  return { version: 1, captured_at: new Date().toISOString(), components, external_credentials: inventory.components.filter(entry => entry.role === "issuer").map(entry => entry.identity) };
}
function* references(db: SqliteDatabase): Generator<WorkArtifactRef> {
  for (const row of db.prepare("SELECT binding,request,observation FROM executions ORDER BY owner,workflow,activity").iterate()) {
    const binding = executionBindingSchema.parse(JSON.parse(String(row.binding))), observation = executorObservationSchema.parse(JSON.parse(String(row.observation)));
    const fields = (value: object) => Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, Reflect.get(value, key)]));
    if (boundFingerprint(fields(observation)) !== boundFingerprint(binding)) throw new Error("recovery observation binding mismatch");
    if (row.request) { const start = executorStartSchema.parse(JSON.parse(String(row.request))); if (boundFingerprint(fields(start)) !== boundFingerprint(binding)) throw new Error("recovery start binding mismatch"); if (start.process_program) { yield start.process_program.runtime; for (const command of Object.values(start.process_program.commands ?? {})) if (command) yield command.runtime; if (start.process_program.bundle) yield start.process_program.bundle.source; } }
    yield binding.source;
  }
  for (const row of db.prepare("SELECT task,permit FROM execution_claim_inbox ORDER BY owner").iterate()) {
    if (row.task) { const task = workTaskSchema.parse(JSON.parse(String(row.task))); if (task.work) { yield task.work.source; if (task.work.process_program) { yield task.work.process_program.runtime; for (const command of Object.values(task.work.process_program.commands ?? {})) if (command) yield command.runtime; if (task.work.process_program.bundle) yield task.work.process_program.bundle.source; } } }
    if (row.permit) { const permit = executorStartSchema.parse(JSON.parse(String(row.permit))); yield permit.source; if (permit.process_program) { yield permit.process_program.runtime; for (const command of Object.values(permit.process_program.commands ?? {})) if (command) yield command.runtime; if (permit.process_program.bundle) yield permit.process_program.bundle.source; } }
  }
  for (const row of db.prepare("SELECT reference FROM execution_stage_outputs ORDER BY owner,workflow,activity,stage").iterate()) yield workArtifactSchema.parse(JSON.parse(String(row.reference)));
  for (const row of db.prepare("SELECT receipt FROM execution_stages WHERE receipt IS NOT NULL ORDER BY owner,workflow,activity,stage").iterate()) {
    const receipt = stageReceiptSchema.parse(JSON.parse(String(row.receipt))); if (receipt.result) yield receipt.result; if (receipt.logs) yield receipt.logs;
  }
  for (const sql of ["SELECT receipt FROM execution_receipts ORDER BY receipt_ref", "SELECT receipt FROM execution_late_evidence ORDER BY owner,workflow,activity,digest"])
    for (const row of db.prepare(sql).iterate()) {
      const receipt = workReceiptSchema.parse(JSON.parse(String(row.receipt))), { receipt_digest, ...unsigned } = receipt;
      if (workReceiptDigest(unsigned) !== receipt_digest) throw new Error("recovery receipt digest mismatch");
      if (receipt.output) yield receipt.output;
      for (const stage of receipt.stages) { if (stage.result) yield stage.result; if (stage.logs) yield stage.logs; }
    }
}
function copyReference(root: string, target: string, reference: WorkArtifactRef) {
  const namespace = createHash("sha256").update(JSON.stringify(reference.owner_identity)).digest("hex"), directory = join(root, namespace);
  let path = join(directory, reference.digest);
  if (!existsSync(path)) path = join(root, ".executor-retained", namespace, reference.digest);
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("unsafe recovery artifact namespace");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), buffer = Buffer.alloc(65536), hash = createHash("sha256");
  const outputDirectory = join(target, namespace); mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const output = join(outputDirectory, reference.digest), out = existsSync(output) ? null : openSync(output, "wx", 0o600);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size !== reference.bytes) throw new Error("recovery artifact size mismatch");
    let bytes = 0, count: number;
    while ((count = readSync(fd, buffer)) > 0) { bytes += count; if (bytes > reference.bytes) throw new Error("recovery artifact grew"); hash.update(buffer.subarray(0, count)); if (out !== null) { let offset = 0; while (offset < count) offset += writeSync(out, buffer, offset, count - offset); } }
    if (bytes !== reference.bytes || hash.digest("hex") !== reference.digest) throw new Error("recovery artifact digest mismatch");
    if (out !== null) fsyncSync(out);
  } finally { closeSync(fd); if (out !== null) closeSync(out); }
  const pins = join(target, ".executor-retained", namespace); mkdirSync(pins, { recursive: true, mode: 0o700 });
  const pin = join(pins, reference.digest); if (!existsSync(pin)) linkSync(output, pin);
}
export function bundleExecutorArtifacts(manifest: WorkRecoveryManifest, inventory: WorkRecoveryInventory, destination: string) {
  for (const entry of manifest.components) if (entry.role === "executor") {
    const original = inventory.components.find(value => value.id === entry.id); if (original?.role !== "executor") throw new Error("executor inventory mismatch");
    entry.artifacts = bundleJournal(entry.id, original.artifact_root, destination);
  }
}
function bundleJournal(id: string, sourceRoot: string, destination: string) {
  if (!lstatSync(sourceRoot).isDirectory()) throw new Error("unsafe executor artifact root");
  sourceRoot = realpathSync(sourceRoot);
  const root = join(destination, "work-recovery"), target = join(root, `${id}-artifacts`); mkdirSync(target, { mode: 0o700 });
  const marker = join(sourceRoot, ".owner");
  if (existsSync(marker) && !lstatSync(marker).isFile()) throw new Error("unsafe executor artifact owner marker");
  const owner = existsSync(marker) ? ref.parse(readBoundedFile(marker, 200).toString()) : null;
  if (owner !== null) writeFileSync(join(target, ".owner"), owner, { mode: 0o600 });
  const db = database(join(root, `${id}.db`)), fd = openSync(join(root, `${id}.jsonl`), "wx", 0o600), hash = createHash("sha256");
  let bytes = 0, entries = 0;
  try { for (const reference of references(db)) { copyReference(sourceRoot, target, reference); const line = Buffer.from(JSON.stringify(reference) + "\n"); let offset = 0; while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset); hash.update(line); bytes += line.length; entries++; } fsyncSync(fd); }
  finally { closeSync(fd); db.close(); }
  return { digest: hash.digest("hex"), bytes, entries, owner };
}
export function checkWorkRecoveryCoverage(db: SqliteDatabase, inventory: { components: readonly { role: Component["role"]; identity: string; workers?: readonly string[] }[] }) {
  for (const row of db.prepare("SELECT DISTINCT issuer FROM workflow_work_nonces").iterate()) if (!inventory.components.some(entry => entry.role === "issuer" && entry.identity === row.issuer)) throw new Error("recovery inventory is missing an accepted issuer");
  for (const row of db.prepare("SELECT DISTINCT broker FROM workflow_work_resource_intents").iterate()) if (!inventory.components.some(entry => entry.role === "broker" && entry.identity === row.broker)) throw new Error("recovery inventory is missing a resource broker");
  for (const row of db.prepare("SELECT DISTINCT worker FROM workflow_work_executions").iterate()) if (!inventory.components.some(entry => entry.role === "executor" && entry.workers?.includes(String(row.worker)))) throw new Error("recovery inventory is missing an assigned executor");
}
export function restoreWorkRecovery(input: WorkRecoveryManifest, snapshot: string, destination: string): WorkRecoveryManifest {
  const manifest = workRecoveryManifestSchema.parse(input), root = join(snapshot, "work-recovery"), target = join(destination, "work-recovery"); mkdirSync(target, { mode: 0o700 });
  for (const entry of manifest.components) {
    const source = join(root, `${entry.id}.db`), actual = fileDigest(source);
    if (actual.digest !== entry.digest || actual.bytes !== entry.bytes || ["-wal", "-shm", "-journal"].some(suffix => existsSync(source + suffix))) throw new Error("work recovery database checksum or sidecar mismatch");
    // Copy only the verified self-contained file. Never let SQLite read an unverified source WAL.
    const path = join(target, `${entry.id}.db`); copyFileSync(source, path, constants.COPYFILE_EXCL); chmodSync(path, 0o600);
    const copied = fileDigest(path); if (copied.digest !== entry.digest || copied.bytes !== entry.bytes) throw new Error("work recovery database changed during restore");
    const db = database(path); try { validate(db, entry); } finally { db.close(); }
    if (entry.role === "executor") {
      if (!entry.artifacts || fileDigest(join(root, `${entry.id}.jsonl`)).digest !== entry.artifacts.digest) throw new Error("missing executor artifact inventory");
      const artifacts = bundleJournal(entry.id, join(root, `${entry.id}-artifacts`), destination);
      if (JSON.stringify(artifacts) !== JSON.stringify(entry.artifacts)) throw new Error("executor artifact inventory mismatch");
    } else if (entry.artifacts !== null) throw new Error("unexpected executor artifacts");
  }
  return manifest;
}

/** Restore local receipt transfer without trusting an unverified public CAS name. */
export function mergeWorkRecoveryArtifacts(manifest: WorkRecoveryManifest, destination: string, owner: string) {
  const target = join(destination, "work-artifacts"); mkdirSync(target, { recursive: true, mode: 0o700 });
  const marker = join(target, ".owner"); if (!existsSync(marker)) writeFileSync(marker, owner, { mode: 0o600, flag: "wx" });
  if (readBoundedFile(marker, 200).toString() !== owner) throw new Error("recovered artifact owner mismatch");
  for (const entry of manifest.components) if (entry.role === "executor") {
    const db = database(join(destination, "work-recovery", `${entry.id}.db`));
    try { for (const reference of references(db)) copyReference(realpathSync(join(destination, "work-recovery", `${entry.id}-artifacts`)), target, reference); }
    finally { db.close(); }
  }
}

/** Every issued, unsettled launch must belong to a supplied journal/inbox. */
export function checkWorkRecoveryAssignments(owner: SqliteDatabase, manifest: WorkRecoveryManifest, directory: string) {
  const journals = manifest.components.filter(entry => entry.role === "executor").map(entry => ({ entry, db: database(join(directory, "work-recovery", `${entry.id}.db`)) }));
  const fields = (value: object) => Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, Reflect.get(value, key)]));
  const stable = (binding: object) => { const { deadline: _deadline, ...rest } = fields(binding); return boundFingerprint(rest); };
  try {
    for (const row of owner.prepare("SELECT e.token,e.worker,e.run_id,e.request FROM workflow_work_executions e JOIN workflow_attempts a ON a.token=e.token WHERE e.activated_at IS NOT NULL AND a.physical_state!='settled'").iterate()) {
      const expected = executorStartSchema.parse(JSON.parse(String(row.request)));
      const found = journals.some(({ entry, db }) => {
        if (!entry.workers.includes(String(row.worker))) return false;
        const retained = db.prepare("SELECT binding FROM executions WHERE owner=? AND workflow=? AND json_extract(binding,'$.attempt_id')=?").get(expected.owner, String(row.run_id), String(row.token));
        if (retained && boundFingerprint(executionBindingSchema.parse(JSON.parse(String(retained.binding)))) === boundFingerprint(fields(expected))) return true;
        const inbox = db.prepare("SELECT task FROM execution_claim_inbox WHERE owner=?").get(expected.owner);
        if (!inbox?.task) return false;
        const task = workTaskSchema.parse(JSON.parse(String(inbox.task)));
        return task.token === row.token && Boolean(task.work && stable(task.work) === stable(expected));
      });
      if (!found) throw new Error("recovery inventory is missing an issued executor attempt");
    }
  } finally { for (const { db } of journals) db.close(); }
}
