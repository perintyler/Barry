/** Provisioned Sessions worker. The credential authorizes only /api/worker. */
import Database from "better-sqlite3";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
import { bagDataDir } from "@barry-rocks/sdk/services";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { WorkActivityWorker, WorkArtifactStore, ExecutorJournal, connectWorkOwnerV3, ownerCall, WORKER_CREDENTIAL_PREFIX,
  retainedWorkAgents, importWorkAgentCatalog, readWorkAgentConfiguration, workAgentCatalogSchema } from "@barry-rocks/sdk/internal/workflows";
import type { InstalledWorkflowRuntimeInstallation } from "./workflow-runtime-installation.js";
import { WorkflowWorkSessions } from "./workflow-work-sessions.js";
import { WorkflowWorkSupervisor } from "./workflow-work-supervisor.js";

const absolute = z.string().min(1).max(4096).refine(isAbsolute);
const configuration = z.strictObject({ version: z.literal(1), directory: absolute, artifact_root: absolute, catalog: absolute,
  owner: z.strictObject({ id: z.string().min(1).max(200), url: z.string().url(), credential_file: absolute }), capacity: z.number().int().min(1).max(100).default(4) });
function credential(path: string): string {
  if (realpathSync(path) !== path) throw new Error("WorkSessionsWorkerCredentialUnavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > 4096 || process.getuid && before.uid !== process.getuid()) throw new Error("WorkSessionsWorkerCredentialUnavailable");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    const after = fstatSync(fd), leaf = lstatSync(path);
    if (length !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs || after.size !== before.size
      || leaf.dev !== after.dev || leaf.ino !== after.ino || leaf.isSymbolicLink()) throw new Error("WorkSessionsWorkerCredentialChanged");
    const value = bytes.subarray(0, length).toString("utf8").trim();
    if (!value.startsWith(WORKER_CREDENTIAL_PREFIX) || !/^\S+$/.test(value)) throw new Error("WorkSessionsWorkerCredentialUnavailable");
    return value;
  } finally { closeSync(fd); }
}
export async function createWorkflowWorkWorker(path: string, installation: InstalledWorkflowRuntimeInstallation, onError: (error: unknown) => void) {
  const config = configuration.parse(readWorkAgentConfiguration(path));
  const catalog = existsSync(config.catalog) ? workAgentCatalogSchema.parse(readWorkAgentConfiguration(config.catalog)) : undefined;
  const node = installationRegistry().id, url = new URL(config.owner.url);
  // Shared local custody only. Remote artifact transfer/identity gateway is an
  // independent acceptance gate, not an implicit filesystem fallback.
  if (config.owner.id !== node || catalog && catalog.installation !== node || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("WorkSessionsWorkerConfigurationUnavailable");
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(config.directory);
  if (realpathSync(config.directory) !== config.directory || directory.isSymbolicLink() || !directory.isDirectory() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error("WorkSessionsWorkerDirectoryUnavailable");
  const lockPath = join(config.directory, "worker-lock.sqlite"), fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error("WorkSessionsWorkerLockUnavailable"); }
  finally { closeSync(fd); }
  const lock = new Database(lockPath);
  let artifacts: WorkArtifactStore | undefined, journal: ExecutorJournal | undefined, sessions: WorkflowWorkSessions | undefined;
  try {
    lock.pragma("busy_timeout=0"); lock.pragma("journal_mode=DELETE"); lock.exec("BEGIN EXCLUSIVE");
    artifacts = new WorkArtifactStore(config.artifact_root, 256 * 1024 * 1024);
    if (artifacts.root !== realpathSync(join(bagDataDir("workflows"), "work-artifacts"))) throw new Error("WorkSessionsSharedOwnerArtifactRootRequired");
    let agents: ReturnType<typeof importWorkAgentCatalog> = [];
    if (catalog) {
      const source = new WorkArtifactStore(catalog.artifact_root, 256 * 1024 * 1024);
      try { agents = importWorkAgentCatalog(catalog, source, artifacts); } finally { source.close(); }
    }
    const client = connectWorkOwnerV3(config.owner.id, ownerCall(config.owner.url, credential(config.owner.credential_file))), clients = new Map([[config.owner.id, client]]);
    journal = new ExecutorJournal({ path: join(config.directory, "executor.sqlite"), installation: node, artifacts });
    sessions = new WorkflowWorkSessions({ installation, directory: join(config.directory, "authority"), clients, artifacts });
    const supervisor = new WorkflowWorkSupervisor({ installation: node, journal, artifacts, sessions, clients, onError });
    const ownerStore = migratedStorePath("workflows", "workflows", () => join(bagDataDir("workflows"), "workflows.db"), "workflows", "node");
    agents = [...new Map([...retainedWorkAgents(ownerStore, artifacts, true), ...agents].map(agent => [agent.source.digest, agent])).values()];
    const types = Object.fromEntries(agents.map(agent => [`agents:${agent.source.digest}@1`, agent.source.digest]));
    const retained = artifacts;
    const worker = new WorkActivityWorker({ executor: "structured-agent", connections: [{ owner: config.owner.id, client }], journal, supervisor,
      advertisement: { types: Object.keys(types), artifacts: types, labels: {} }, capacity: config.capacity, onError,
      features: () => ({ version: 2, installation: node, boot_identity: supervisor.bootIdentity, observed_at: Date.now(), expires_at: Date.now() + 15000,
        executors: ["structured-agent"], features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "bounded-retries", "endpoint-arbiter", "declared-validation"], runtimes: {}, workspaces: [], containment: "portable", requires_validation_declaration: true }),
      prepare: async task => {
        if (!task.work?.agent_program || types[task.type] !== task.artifact || task.work.source.digest !== task.artifact || task.work.output_identity === undefined) throw new Error("WorkSessionsWorkerActivityUnavailable");
        retained.verify(task.work.agent_program.profile);
      } });
    const retainedJournal = journal, retainedArtifacts = artifacts;
    let closing: Promise<void> | undefined;
    return { worker, supervisor, journal, sessions, close: () => closing ??= (async () => {
      // Unknown custody is retained on disk even if shutdown cannot establish cessation.
      // A failed physical drain retains the lifetime lock and open custody.
      // Process exit releases the kernel lock; a later service can reconcile
      // the durable unknown entry, never repeat its input.
      await worker.close();
      const failures: unknown[] = [];
      for (const close of [() => retainedJournal.close(), () => retainedArtifacts.close(), () => lock.close()]) try { close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "WorkSessionsWorkerStoreCloseFailed");
    })() };
  } catch (error) {
    const failures: unknown[] = [error];
    try { await sessions?.close(); } catch (cleanup) {
      // Do not release custody while an already-created backend may remain live.
      throw new AggregateError([...failures, cleanup], "WorkSessionsWorkerSetupDrainFailed");
    }
    for (const close of [() => journal?.close(), () => artifacts?.close(), () => lock.close()]) try { close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "WorkSessionsWorkerSetupFailed");
    throw error;
  }
}
