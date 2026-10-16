import { randomUUID } from "node:crypto";
import type { SqliteConnection } from "../stores/sqlite-connection.js";

/**
 * Fence a workflows database that was restored from a copy.
 *
 * Workers and attempts recorded in the copy belong to an owner that no longer
 * exists, so the epoch changes, active attempts expire, leased commands go
 * back to pending (or fail when their attempts are spent), and every running
 * run is blocked until someone reconciles its external effects and resumes it.
 * Returns the new epoch.
 */
export function pauseRestoredRuns(db: SqliteConnection, snapshotAt: string | null = null): string {
  const epoch = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE workflow_meta SET value=? WHERE key='epoch'").run(epoch);
    db.prepare("INSERT INTO workflow_meta(key,value) VALUES('recovery-admission',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ version: 1, epoch, snapshot_at: snapshotAt, restored_at: new Date().toISOString(), active: false }));
    db.prepare("INSERT INTO workflow_meta(key,value) VALUES('recovery-work-views',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ epoch, after: "", complete: false }));
    db.exec("UPDATE workflow_worker_sessions SET retired=1");
    db.exec("UPDATE workflow_attempts SET state='expired' WHERE state='active'; UPDATE workflow_commands SET state='done',outcome='{" + '"ok":false,"error":{"code":"RecoveryInterrupted","message":"attempt budget exhausted during recovery","retryable":false}' + "}',token=NULL,lease_until=NULL WHERE state='leased' AND attempts>=json_extract(definition,'$.retry.maxAttempts'); UPDATE workflow_commands SET state='pending',token=NULL,lease_until=NULL WHERE state='leased'; DELETE FROM workflow_due; DELETE FROM workflow_claims; DELETE FROM workflow_meta WHERE key LIKE 'session:%';");
    db.exec("UPDATE workflow_runs SET status='blocked',error='RecoveryPaused: reconcile external effects before resume',revision=revision+1 WHERE status IN ('running','blocked'); INSERT INTO workflow_due(run_id,due_at) SELECT id,deadline FROM workflow_runs WHERE status='blocked';");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return epoch;
}
