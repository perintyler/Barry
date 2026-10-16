import { WorkActivityWorker, type WorkOwnerConnection } from "./work-activity-worker.js";
import { WorkProcessSupervisor } from "./work-process-supervisor.js";
import { ProcessExecutor } from "./executor.js";
import { ExecutorJournal } from "./executor-journal.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { artifactAbi, verifyArtifact } from "./artifacts.js";
import type { WorkerAdvertisement, ActivityTask } from "./types.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Installation composition for the portable process adapter. Registry and owner
 * clients are trusted configuration; no caller-supplied shell, artifact path or credential. */
export function createProcessWorkWorker(options: {
  installation: string;
  journalPath: string;
  artifactRoot: string;
  connections: { owner: string; client: WorkOwnerConnection }[];
  advertisement: Omit<WorkerAdvertisement, "capacity">;
  prepare?: (task: ActivityTask) => Promise<void>;
  capacity?: number;
  maxArtifactBytes?: number;
  tempRoot?: string;
  /** Must resolve only the explicit retained credential owner/names; never fall back to host credentials. */
  resolveProcessSecrets?: (start: NonNullable<ActivityTask["work"]>) => Promise<Record<string, string>>;
  onError?: (error: unknown) => void;
}) {
  mkdirSync(dirname(options.journalPath), { recursive: true, mode: 0o700 });
  const journalPath = existsSync(options.journalPath) ? realpathSync(options.journalPath) : resolve(realpathSync(dirname(options.journalPath)), options.journalPath.split("/").at(-1)!);
  // A kernel-backed lifetime lock prevents two hosts from treating one another's
  // live processes as orphaned. Readers and receipt inspection remain possible.
  const lock = new SqliteDatabase(`${journalPath}.worker-lock`);
  try { lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); }
  catch (error) { lock.close(); throw error; }
  let artifacts: WorkArtifactStore | undefined, journal: ExecutorJournal | undefined;
  try {
    artifacts = new WorkArtifactStore(options.artifactRoot, options.maxArtifactBytes);
    journal = new ExecutorJournal({ path: journalPath, installation: options.installation, artifacts });
    const retainedArtifacts = artifacts, retainedJournal = journal;
    const clients = new Map(options.connections.map(connection => [connection.owner, connection.client]));
    const executor = new ProcessExecutor({ maxChildren: options.capacity ?? 4, tempRoot: options.tempRoot ?? dirname(journalPath), artifacts, installation: options.installation, resolveProcessSecrets: options.resolveProcessSecrets });
    const supervisor = new WorkProcessSupervisor({ installation: options.installation, journal, artifacts, executor,
      authorize: async start => { const client = clients.get(start.owner); return client && await client.effect(start.attempt_id) ? client.begin(start.attempt_id) : null; },
      outputIdentity: start => { if (start.output_identity === undefined) throw new Error("owner permit lacks an output namespace"); return start.output_identity; },
      onError: options.onError });
    const worker = new WorkActivityWorker({ ...options, journal, supervisor,
      features: () => ({ version: 2, installation: options.installation, boot_identity: supervisor.bootIdentity, observed_at: Date.now(), expires_at: Date.now() + 15000,
      executors: ["process"], features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "bounded-retries", "declared-validation", "stage-logs", "process-program", "process-program-envelope", "process-program-bundle", "action-command-stages", ...(process.allowedNodeEnvironmentFlags.has("--allow-net") ? ["node-job" as const] : [])],
        runtimes: {}, workspaces: [], containment: "portable", requires_validation_declaration: true }),
      prepare: async task => {
        if (!task.work || task.work.output_identity === undefined || !task.work.validation || task.work.activity_type !== task.type)
          throw new Error("owner permit lacks the declared process contract");
        await options.prepare?.(task);
        retainedArtifacts.verify(task.work.source);
        if (task.work.process_program) {
          retainedArtifacts.retainExecutor(task.work.source);
          retainedArtifacts.retainExecutor(task.work.process_program.runtime);
          if (task.work.process_program.bundle) retainedArtifacts.retainExecutor(task.work.process_program.bundle.source);
          for (const command of Object.values(task.work.process_program.commands ?? {})) if (command) retainedArtifacts.retainExecutor(command.runtime);
        }
        if (!task.work.process_program) verifyArtifact({ path: retainedArtifacts.path(task.work.source), digest: task.work.source.digest, abi: artifactAbi, type: task.type, version: "activity" });
      } });
    let closing: Promise<void> | undefined;
    return { worker, supervisor, journal, artifacts, close: () => closing ??= (async () => {
      try { await worker.close(); }
      finally { retainedJournal.close(); retainedArtifacts.close(); lock.close(); }
    })() };
  } catch (error) {
    journal?.close(); artifacts?.close(); lock.close(); throw error;
  }
}
