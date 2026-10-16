import { Barry, BarryError, type AtScheduleInput, type AtScheduleQuery, type Caller, type Schedule, type Schedules } from "@barry-rocks/sdk";
import { listSchedules } from "./registry.js";
import { listStates } from "./store.js";
import { listAtSchedules, cancelAtSchedule, getAtSchedule } from "./at-schedules.js";
import { schedulerHealth } from "./health.js";
import { summarizeSchedule } from "./tools.js";
import { serializeAtSchedule } from "./domain.js";
import { scheduleAt } from "./once.js";

function allowed(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read or create schedules");
}

export const schedules = {
  name: "schedules" as const,
  async list(caller: Caller) {
    allowed(caller);
    const found = await listSchedules(), states = listStates();
    return found.schedules.map(entry => {
      const s = summarizeSchedule(entry, states.get(entry.id));
      return {
        id: s.id, trigger: s.trigger, action: s.action,
        ...(s.job ? { job: s.job } : {}), ...(s.description ? { description: s.description } : {}),
        enabled: s.enabled, paused: s.paused, nextFireAt: s.next_fire_at, lastFiredAt: s.last_fired_at,
        lastStatus: s.last_status, lastSummary: s.last_summary, lastRunId: s.last_run_id,
        consecutiveFailures: s.consecutive_failures, skippedFires: s.skipped_fires, missedFires: s.missed_fires,
      } satisfies Schedule;
    });
  },
  async scheduler(caller: Caller) {
    allowed(caller);
    const health = schedulerHealth(), { errors } = await listSchedules();
    return { status: health.status, reason: "reason" in health ? health.reason : null,
      heartbeatAt: health.heartbeat?.at.toISOString() ?? null, loadErrors: errors };
  },
  async atSchedules(query: AtScheduleQuery, caller: Caller) {
    allowed(caller);
    return listAtSchedules(query).map(serializeAtSchedule);
  },
  async cancelAtSchedule(id: string, caller: Caller) {
    allowed(caller);
    if (!cancelAtSchedule(id)) throw new BarryError("not_found", `One-off not found: ${id}`);
    return serializeAtSchedule(getAtSchedule(id)!);
  },
  async scheduleAt(input: AtScheduleInput, caller: Caller) {
    allowed(caller);
    // HTTP callers meet the wire schema's bound; in-process callers must get the same answer.
    if (input.attempts !== undefined && !(Number.isInteger(input.attempts) && input.attempts >= 1 && input.attempts <= 5))
      throw new BarryError("invalid", `attempts must be a whole number from 1 to 5, not ${input.attempts}`);
    const identity = input.identity !== undefined ? await Barry.as(caller).identity(input.identity).get() : undefined;
    const selectedBags = input.bags;
    const result = await scheduleAt({
      action: input.action, inputs: input.inputs, dueAt: input.dueAt instanceof Date ? input.dueAt.toISOString() : input.dueAt,
      ...(identity ? { identity: identity.name } : {}),
      ...(selectedBags ? { bags: [...selectedBags] } : {}), ...(input.bounds ? { bounds: [...input.bounds] } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attempts !== undefined ? { retry: { attempts: input.attempts } } : {}),
    }, identity?.id);
    return serializeAtSchedule(result.schedule);
  },
} satisfies Schedules;
