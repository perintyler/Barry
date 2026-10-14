import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import { mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowArtifact } from "./artifacts.js";
import type { WorkflowOwner } from "./workflow-owner.js";
import { snapshotWorkflows } from "./recovery.js";

/** Opt-in archive-before-prune maintenance; never deletes archived snapshots. */
export class WorkflowMaintenance {
  private archive?: DatabaseSync;
  private pending?: Promise<void>;
  private stopped = false;
  private nextAt = 0;
  private lastSnapshotAt: number | null = null;
  private failure = false;
  constructor(private readonly options: { owner: WorkflowOwner; database: string; archiveDirectory: string; artifacts: WorkflowArtifact[]; retainDays?: number; now?: () => number }) {
    if (!isAbsolute(options.archiveDirectory) || !isAbsolute(options.database)) throw new Error("maintenance requires absolute database and archive paths");
    if (!Number.isInteger(options.retainDays ?? 30) || (options.retainDays ?? 30) < 1) throw new Error("retention must be at least one day");
    mkdirSync(options.archiveDirectory, { recursive: true, mode: 0o700 });
  }
  status() { return { enabled: true, state: this.stopped ? "stopped" : this.pending ? "snapshotting" : this.failure ? "archive_failed" : this.archive ? "ready" : "starting", lastSnapshotAt: this.lastSnapshotAt, nextSnapshotInMs: Math.max(0, this.nextAt - performance.now()), retainDays: this.options.retainDays ?? 30, snapshotDeletion: "operator-managed" }; }
  tick(): void {
    if (this.stopped || this.pending || !this.options.owner.storageAccounted) return;
    const at = (this.options.now ?? Date.now)();
    if (performance.now() >= this.nextAt) {
      const destination = join(this.options.archiveDirectory, `workflow-${randomUUID()}`);
      this.pending = snapshotWorkflows(this.options.database, destination, this.options.owner.id, this.options.artifacts).then(() => {
        const archive = new DatabaseSync(join(destination, "workflows.db"), { readOnly: true });
        this.archive?.close(); this.archive = archive; this.lastSnapshotAt = at; this.failure = false;
        this.nextAt = performance.now() + 86_400_000;
      }).catch(() => {
        // No pruning after a failed archive attempt. Preserve all earlier files.
        this.archive?.close(); this.archive = undefined; this.failure = true;
        this.nextAt = performance.now() + 60_000;
      }).finally(() => { this.pending = undefined; });
      return;
    }
    if (!this.archive || this.failure) return;
    this.options.owner.prune(at - (this.options.retainDays ?? 30) * 86_400_000, run => {
      // A wall-clock jump cannot make a post-snapshot terminal run look covered.
      const archived = this.archive!.prepare("SELECT revision,status FROM workflow_runs WHERE id=?").get(run.id);
      return archived?.revision === run.revision && archived.status === run.status;
    });
  }
  async close(): Promise<void> { this.stopped = true; await this.pending; this.archive?.close(); this.archive = undefined; }
}
