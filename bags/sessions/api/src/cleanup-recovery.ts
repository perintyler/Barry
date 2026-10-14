import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { startProcessCleanupRecovery } from "@barry-rocks/sessions-bag/store/process-cleanup-recovery";

/**
 * Replay process cleanup that ending or deleting a session left behind for
 * the node's process history, in the background, for as long as this process
 * runs. It belongs to an always-on service's startup rather than to any
 * request, and this API is that service.
 *
 * `warn` hears a report only when it changes, so a stuck intent is said once
 * rather than every poll.
 */
export function startCleanupRecovery(warn: (detail: string) => void): { stop(): void } {
  let lastWarning = "";
  return startProcessCleanupRecovery({
    control: getSessionsSqlite(),
    onReport(report) {
      const warning = report.failed || report.oversized || report.unsupported || report.generationChanged
        ? JSON.stringify({ failed: report.failed, oversized: report.oversized, unsupported: report.unsupported, generationChanged: report.generationChanged })
        : "";
      if (warning && warning !== lastWarning) warn(warning);
      lastWarning = warning;
    },
  });
}
