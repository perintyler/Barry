import { createLogger } from "@barry-rocks/sdk/logging";
import { Messages } from "@barry-rocks/sessions-bag/client";

const log = createLogger("barry-server").child({ component: "ttl-cleanup" });
const TARGET_HOUR = parseInt(process.env.TTL_CLEANUP_HOUR || "2", 10); // Default to 2 AM
const RETENTION_DAYS = parseInt(process.env.TTL_RETENTION_DAYS || "365", 10); // Default to 1 year

let schedulerInterval: NodeJS.Timeout | null = null;
let schedulerGeneration = 0;

function getMsUntilNextCheck(): number {
  const now = new Date();

  const target = new Date(now);
  target.setHours(TARGET_HOUR, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

async function cleanupExpiredRows(): Promise<void> {
  log.info("cleanup.start");

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

    // Delete expired messages in bounded batches without preliminary full-table counts.
    // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
    const result = await Messages.deleteOlderThan(cutoffDate);

    if (result.deletedRows === 0) {
      log.info("cleanup.none_expired", { cutoff: cutoffDate.toISOString() });
      return;
    }

    log.info("cleanup.complete", {
      deletedRows: result.deletedRows,
      batches: result.batches,
      cutoff: cutoffDate.toISOString(),
      // Budget hit before the cutoff's full backlog was cleared — the next
      // scheduled run picks up where this one left off. Logged explicitly
      // rather than left implicit, so a persistently-growing backlog (the
      // scheduler falling behind its own retention window) is visible
      // instead of silently re-hitting the budget forever.
      budgetExhausted: result.budgetExhausted,
    });
  } catch (error) {
    log.error("cleanup.error", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function startTtlCleanup(): void {
  stopTtlCleanup();
  const generation = schedulerGeneration;
  log.info("scheduler.start", { targetHour: TARGET_HOUR, retentionDays: RETENTION_DAYS });

  const scheduleNext = () => {
    if (generation !== schedulerGeneration) return;
    const msUntilNext = getMsUntilNextCheck();
    const hoursUntilNext = (msUntilNext / 1000 / 60 / 60).toFixed(2);
    log.info("scheduler.next_run", { hoursUntilNext: Number(hoursUntilNext) });

    schedulerInterval = setTimeout(async () => {
      if (generation !== schedulerGeneration) return;
      schedulerInterval = null;
      await cleanupExpiredRows();
      scheduleNext();
    }, msUntilNext);
    schedulerInterval.unref();
  };

  scheduleNext();
}

export function stopTtlCleanup(): void {
  schedulerGeneration++;
  if (schedulerInterval) {
    clearTimeout(schedulerInterval);
    schedulerInterval = null;
  }
  log.info("scheduler.stopped");
}

// Manual trigger for testing
export { cleanupExpiredRows };
