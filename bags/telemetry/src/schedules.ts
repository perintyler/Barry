/** The Schedules page reads the API through Barry's domain handles. */
import { Barry } from "@barry-rocks/sdk";

const OVERDUE_MS = 5 * 60_000;

export async function scheduleOverview() {
  const [health, schedules] = await Promise.all([Barry.scheduler(), Barry.schedules()]);
  const now = Date.now();
  const rows = await Promise.all(schedules.map(async s => {
    const runs = await Barry.schedule(s.id).runs();
    const due = s.nextFireAt ? Date.parse(s.nextFireAt) : null;
    return {
      id: s.id, trigger: s.trigger, action: s.action,
      ...(s.job ? { job: s.job } : {}), ...(s.description ? { description: s.description } : {}),
      enabled: s.enabled, paused: s.paused, next_fire_at: s.nextFireAt, last_fired_at: s.lastFiredAt,
      last_status: s.lastStatus, last_summary: s.lastSummary, last_run_id: s.lastRunId,
      consecutive_failures: s.consecutiveFailures, skipped_fires: s.skippedFires, missed_fires: s.missedFires,
      overdue: !s.paused && s.enabled && due !== null && now - due > OVERDUE_MS,
      runs: runs.slice(0, 30).map(r => ({
        id: r.id, status: r.status === "running" ? "started" : r.status === "succeeded" ? "complete" : r.status,
        started_at: r.startedAt, duration_ms: r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null,
        summary: r.summary,
      })),
    };
  }));
  const oneOffs = await Promise.all((["running", "pending", "uncertain", "failed"] as const).map(status =>
    Barry.oneOffs({ status, limit: status === "failed" ? 10 : 50 })));
  return {
    state: "ok", generatedAt: now,
    scheduler: { status: health.status, ...(health.reason ? { reason: health.reason } : {}), heartbeat_at: health.heartbeatAt },
    load_errors: health.loadErrors, schedules: rows,
    one_offs: oneOffs.flat().map(o => ({
      id: o.id, action: o.job ? `job ${o.job}` : o.action ?? "inline", ...(o.job ? { job: o.job } : {}),
      due_at: o.dueAt, status: o.status, ...(o.reason ? { reason: o.reason } : {}),
      ...(Object.keys(o.inputs).length ? { inputs: o.inputs } : {}), failures: o.failures, recoveries: o.recoveries,
    })),
  };
}
