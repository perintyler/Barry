import BetterSqlite3 from "better-sqlite3";
import { opendirSync, lstatSync, realpathSync, type Dir } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { storePath } from "@barry-rocks/sdk/stores";
import { drainProcessCleanup, normalizeProcessCleanupIntent } from "./process-cleanup.js";

export interface CleanupRecoveryReport {
  entries: number; stores: number; applied: number; normalized: number; failed: number;
  oversized: number; unsupported: number; deferred: boolean; generationChanged: boolean;
}
interface RecoveryOptions {
  control: BetterSqlite3.Database;
  root?: () => string;
  now?: () => number;
  entriesPerPoll?: number;
  storesPerPoll?: number;
  intentsPerStore?: number;
  budgetMs?: number;
  busyMs?: number;
}
function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid process cleanup recovery bound");
  return value;
}

export function createProcessCleanupRecovery(options: RecoveryOptions) {
  const { control } = options, root = options.root ?? activeStoreRoot, now = options.now ?? (() => performance.now());
  const generation = root(), directory = join(generation, "identities");
  const controlPath = storePath({ node: "local", bag: "sessions", store: "catalog" }, "node", generation);
  const entriesPerPoll = bounded(options.entriesPerPoll ?? 32, 1000), storesPerPoll = bounded(options.storesPerPoll ?? 8, 100);
  const intentsPerStore = bounded(options.intentsPerStore ?? 16, 1000), budgetMs = bounded(options.budgetMs ?? 200, 1000), busyMs = bounded(options.busyMs ?? 25, 100);
  const cursors = new Map<string, number>();
  let entries: Dir | undefined, stopped = false;
  const closeDirectory = () => { entries?.closeSync(); entries = undefined; };
  const poll = (): CleanupRecoveryReport => {
    const report: CleanupRecoveryReport = { entries: 0, stores: 0, applied: 0, normalized: 0, failed: 0, oversized: 0, unsupported: 0, deferred: false, generationChanged: false };
    if (stopped) return report;
    try { if (root() !== generation || control.name !== controlPath) { closeDirectory(); report.generationChanged = true; return report; } }
    catch { closeDirectory(); report.failed++; return report; }
    if (control.inTransaction) { report.deferred = true; return report; }
    const deadline = now() + budgetMs;
    let oldBusy: number | undefined;
    try {
      oldBusy = control.pragma("busy_timeout", { simple: true }) as number;
      if (!entries) {
        try { entries = opendirSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.failed++; return report; }
      }
      control.pragma(`busy_timeout=${busyMs}`);
      while (report.entries < entriesPerPoll && report.stores < storesPerPoll) {
        if (now() >= deadline) { report.deferred = true; break; }
        const entry = entries.readSync();
        if (!entry) { closeDirectory(); break; }
        report.entries++;
        if (!entry.isDirectory()) continue;
        let source: BetterSqlite3.Database | undefined;
        try {
          const path = storePath({ node: "local", identity: entry.name, bag: "sessions", store: "sessions" }, "identity", generation);
          try { if (!lstatSync(path).isFile()) continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          const within = relative(realpathSync(generation), realpathSync(path));
          if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new Error("Cleanup source is outside the active generation");
          source = new BetterSqlite3(path, { fileMustExist: true });
          source.pragma(`busy_timeout=${busyMs}`); source.pragma("synchronous=FULL");
          report.stores++;
          if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_cleanup_intents'").get()) { report.unsupported++; continue; }
          const intents = source.prepare("SELECT id,json_array_length(instances) AS count,length(CAST(instances AS BLOB)) AS bytes FROM process_cleanup_intents WHERE id>? ORDER BY id LIMIT ?")
            .all(cursors.get(path) ?? 0, intentsPerStore) as { id: number; count: number; bytes: number }[];
          if (intents.length === 0) cursors.delete(path);
          for (const intent of intents) {
            if (now() >= deadline) { report.deferred = true; break; }
            // A poisoned intent must not starve later work in this partition.
            cursors.delete(path); cursors.set(path, intent.id);
            if (cursors.size > 1024) cursors.delete(cursors.keys().next().value!);
            if (intent.count > 1) {
              try { report.normalized += normalizeProcessCleanupIntent(source, intent.id); } catch { report.failed++; }
              continue;
            }
            if (intent.bytes > 1024 * 1024) { report.oversized++; continue; }
            try { report.applied += drainProcessCleanup(source, control, 1, intent.id - 1, intent.id); }
            catch { report.failed++; }
          }
        } catch { report.failed++; }
        finally { source?.close(); }
      }
    } catch { closeDirectory(); report.failed++; }
    finally { if (oldBusy !== undefined) { try { control.pragma(`busy_timeout=${oldBusy}`); } catch { report.failed++; } } }
    return report;
  };
  return { poll, stop() { stopped = true; closeDirectory(); cursors.clear(); } };
}

export function startProcessCleanupRecovery(options: RecoveryOptions & { intervalMs?: number; onReport?: (report: CleanupRecoveryReport) => void }) {
  const intervalMs = bounded(options.intervalMs ?? 30_000, 300_000);
  const recovery = createProcessCleanupRecovery(options);
  const tick = () => { const report = recovery.poll(); options.onReport?.(report); };
  // Recovery belongs to service startup, not application imports or requests.
  tick();
  const timer = setInterval(tick, intervalMs); timer.unref();
  return { stop() { clearInterval(timer); recovery.stop(); } };
}
