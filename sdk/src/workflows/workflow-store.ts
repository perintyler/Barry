import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import type { SQLInputValue } from "node:sqlite";
import { mkdirSync, realpathSync, existsSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { encodeRecord as encode, type Json } from "./types.js";
import { migrate } from "./migrations.js";
import { WorkflowError } from "./errors.js";

export class WorkflowStore {
  private db: DatabaseSync;
  private readonly ownerLock?: DatabaseSync;
  private readonly path: string;
  private pressure = false;
  private uncertain = false;
  constructor(path: string, private readonly owner: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    path = path === ":memory:" ? path : existsSync(path) ? realpathSync(path) : `${realpathSync(dirname(path))}/${path.split("/").at(-1)}`;
    this.path = path;
    if (path !== ":memory:" && existsSync(path) && statSync(path).nlink > 1) throw new Error("workflow store must not be hard-linked");
    // A separate rollback-journal database supplies a kernel-backed lifetime lock.
    // No timeout/mtime-based stealing: the OS releases it on process death.
    if (path !== ":memory:") {
      this.ownerLock = new DatabaseSync(`${path}.owner-lock`);
      try { this.ownerLock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); }
      catch (error) { this.ownerLock.close(); throw error; }
    }
    try { this.db = new DatabaseSync(path); }
    catch (error) { this.ownerLock?.close(); throw error; }
    try {
      this.db.exec("PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON;");
      migrate(this.db, owner);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      // Acquiring the lifetime owner lock proves the preceding owner is gone.
      // Its evaluator reservations cannot produce a result after recovery.
      this.transaction(() => this.run("UPDATE workflow_due SET token=NULL,reserved_until=0"));
    } catch (error) { this.db.close(); this.ownerLock?.close(); throw error; }
  }
  transaction<T>(body: () => T): T {
    this.ensureConnection();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try { const result = body(); committing = true; this.db.exec("COMMIT"); return result; }
    catch (error) { this.rollback(committing); throw error; }
  }
  read<T>(body: () => T): T {
    this.ensureConnection();
    this.db.exec("BEGIN");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.rollback(false); throw error; }
  }
  private rollback(commitWasAttempted: boolean): void {
    let rolledBack = false;
    try { this.db.exec("ROLLBACK"); rolledBack = true; } catch { /* Preserve the original fault. */ }
    // Auto-rollback is safe only if SQLite positively confirms autocommit. A
    // commit error is always ambiguous, even when COMMIT actually took effect.
    this.uncertain = commitWasAttempted || (!rolledBack && Reflect.get(this.db, "isTransaction") !== false);
  }
  private ensureConnection(): void {
    if (!this.uncertain) return;
    if (this.path === ":memory:") throw new WorkflowError("StoreRecoveryRequired", "In-memory connection state is uncertain; restart the owner.", 503);
    try {
      // Keep the lifetime owner lock while discarding the uncertain connection.
      if (Reflect.get(this.db, "isOpen")) this.db.close();
      const replacement = new DatabaseSync(this.path);
      try {
        replacement.exec("PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON;");
        migrate(replacement, this.owner);
        replacement.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      } catch (error) { replacement.close(); throw error; }
      this.db = replacement; this.uncertain = false;
    } catch { throw new WorkflowError("StoreUnavailable", "Cannot re-establish a clean storage connection; preserve request identities and retry later.", 503, true); }
  }
  run(sql: string, ...values: SQLInputValue[]): void { this.ensureConnection(); this.db.prepare(sql).run(...values); }
  admit(reservedBytes: number): void {
    this.assertAccounted();
    if (this.path === ":memory:") return;
    const size = statSync(this.path).size + (existsSync(`${this.path}-wal`) ? statSync(`${this.path}-wal`).size : 0);
    const disk = statfsSync(dirname(this.path)), free = disk.bavail * disk.bsize;
    if (size > 858_993_459 || free < Math.max(0, reservedBytes - size) + 268_435_456) this.pressure = true;
    else if (size < 751_619_276) this.pressure = false;
    if (this.pressure) throw new Error("owner storage high-water admission limit reached; checkpoint or archive closed runs");
  }
  get accounted(): boolean { return this.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='bytes-accounted'")?.value === "1"; }
  assertAccounted(): void { if (!this.accounted) throw new WorkflowError("MigrationInProgress", "Legacy storage accounting is in progress; retry this request after readiness recovers.", 503, true); }
  /** Checkpoint one 64-row legacy accounting page. No payload JSON is materialized. */
  backfillTurn(): void {
    if (this.accounted) return;
    this.transaction(() => {
      const run = this.one<{ id: string; revision: number; bytes: number; status: string }>("SELECT id,revision,length(CAST(input AS BLOB))+length(CAST(request AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)+512+CASE WHEN status IN ('running','blocked') THEN 1048576 ELSE 0 END bytes,status FROM workflow_runs WHERE budget_bytes=0 ORDER BY id LIMIT 1");
      if (!run) { this.run("UPDATE workflow_meta SET value='1' WHERE key='bytes-accounted'"); this.run("DELETE FROM workflow_byte_backfill"); return; }
      let progress = this.one<{ run_id: string; revision: number; phase: number; cursor: number; bytes: number }>("SELECT * FROM workflow_byte_backfill WHERE id=1");
      if (!progress || progress.run_id !== run.id || progress.revision !== run.revision) {
        this.run("INSERT OR REPLACE INTO workflow_byte_backfill VALUES(1,?,?,0,0,?)", run.id, run.revision, run.bytes);
        progress = { run_id: run.id, revision: run.revision, phase: 0, cursor: 0, bytes: run.bytes };
      }
      const phases = [
        ["workflow_groups", "length(CAST(definition AS BLOB))+256"],
        ["workflow_commands", "length(CAST(definition AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)+512+CASE WHEN state IN ('pending','leased') THEN 786432+coalesce(json_extract(definition,'$.retry.maxAttempts'),1)*16384 ELSE 0 END"],
        ["workflow_events", "length(CAST(details AS BLOB))+256"],
        ["workflow_signals", "length(CAST(payload AS BLOB))+256"],
        ["workflow_payloads", "bytes+256"],
        ["workflow_receipts", "length(CAST(request AS BLOB))+length(CAST(response AS BLOB))+256"],
        ["workflow_grants", "length(CAST(evidence AS BLOB))+512"],
        ["workflow_session_bindings", "512"],
        ["workflow_work_admissions", "length(CAST(record AS BLOB))+512"],
        ["workflow_work_grants", "length(CAST(evidence AS BLOB))+512"],
        ["workflow_work_sources", "256"],
        ["workflow_work_reservations", "512"],
        ["workflow_work_outbox", "length(CAST(body AS BLOB))+512"],
        ["workflow_work_nonces", "length(CAST(binding AS BLOB))+512"],
      ["workflow_work_delegations", "length(CAST(evidence AS BLOB))+512"],
      ["workflow_work_executions", "length(CAST(request AS BLOB))+length(CAST(observation AS BLOB))+coalesce(length(CAST(receipt AS BLOB)),0)+512"],
      ["workflow_work_index", "length(installation)+length(namespace_hash)+coalesce(length(identity_id),0)+length(state)+length(definition_ref)+512"],
      ["workflow_work_resource_intents", "length(CAST(request AS BLOB))+coalesce(length(CAST(settlement AS BLOB)),0)+512"],
      ["workflow_work_reconciliations", "length(CAST(request AS BLOB))+length(CAST(audit AS BLOB))+length(CAST(response AS BLOB))+512"],
        ["workflow_attempts", "coalesce(length(CAST(outcome AS BLOB)),0)+512"],
      ];
      const [table, expression] = phases[progress.phase];
      const scope = table === "workflow_attempts" ? "command_id IN (SELECT id FROM workflow_commands WHERE run_id=?)" : "run_id=?";
      const page = this.rows<{ cursor: number; bytes: number }>(`SELECT rowid cursor,${expression} bytes FROM ${table} WHERE ${scope} AND rowid>? ORDER BY rowid LIMIT 64`, run.id, progress.cursor);
      const bytes = progress.bytes + page.reduce((sum, row) => sum + row.bytes, 0);
      const phase = progress.phase + (page.length < 64 ? 1 : 0), cursor = page.length < 64 ? 0 : page.at(-1)!.cursor;
      if (phase === phases.length) {
        this.run("UPDATE workflow_runs SET budget_bytes=? WHERE id=?", bytes, run.id);
        this.run("UPDATE workflow_meta SET value=CAST(CAST(value AS INTEGER)+? AS TEXT) WHERE key='reserved-bytes'", bytes);
        this.run("DELETE FROM workflow_byte_backfill");
      } else this.run("UPDATE workflow_byte_backfill SET phase=?,cursor=?,bytes=? WHERE id=1", phase, cursor, bytes);
    });
  }
  one<T>(sql: string, ...values: SQLInputValue[]): T | undefined { this.ensureConnection(); return this.db.prepare(sql).get(...values) as T | undefined; }
  rows<T>(sql: string, ...values: SQLInputValue[]): T[] { this.ensureConnection(); return this.db.prepare(sql).all(...values) as T[]; }
  *iterate<T>(sql: string, ...values: SQLInputValue[]): Generator<T> { this.ensureConnection(); for (const row of this.db.prepare(sql).iterate(...values)) yield row as T; }
  event(runId: string, at: number, type: string, details: Json): void {
    const compact = details && !Array.isArray(details) && typeof details === "object" ? { ...details } : details;
    if (compact && !Array.isArray(compact) && typeof compact === "object") {
      for (const field of ["definition", "outcome"]) {
        const record = compact[field];
        if (!record || Array.isArray(record) || typeof record !== "object") continue;
        const key = field === "definition" ? "input" : "value";
        if (!(key in record)) continue;
        const value = encode(record[key]), id = createHash("sha256").update(value).digest("hex");
        this.run("INSERT OR IGNORE INTO workflow_payloads VALUES(?,?,?,?)", runId, id, value, Buffer.byteLength(value));
        compact[field] = { ...record, [key]: { payloadRef: id, bytes: Buffer.byteLength(value) } };
      }
    }
    this.run("INSERT INTO workflow_events(run_id,at,type,details) VALUES(?,?,?,?)", runId, at, type, encode(compact));
    this.run("UPDATE workflow_runs SET revision=revision+1 WHERE id=?", runId);
    this.run("INSERT INTO workflow_due(run_id,due_at) SELECT id,? FROM workflow_runs WHERE id=? AND status IN ('running','blocked') ON CONFLICT(run_id) DO UPDATE SET due_at=min(due_at,excluded.due_at),dirty=1,failures=0", at, runId);
  }
  close(): void { try { if (Reflect.get(this.db, "isOpen")) this.db.close(); } finally { this.ownerLock?.close(); } }
}
