import { Barry, BarryError, type Caller, type Schedule, type Schedules } from "@barry-rocks/sdk";
import { listSchedules } from "./catalog.js";
import { listStates } from "./store.js";
import { listOneOffs, cancelOneOff, getOneOff } from "./one-offs.js";
import { schedulerHealth } from "./health.js";
import { summarizeSchedule } from "./tools.js";
import { serializeOneOff } from "./domain.js";
import { scheduleOnce } from "./once.js";

function allowed(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read or create schedules");
}

export const schedules: Schedules = {
  name: "schedules",
  async list(caller) {
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
  async scheduler(caller) {
    allowed(caller);
    const health = schedulerHealth(), { errors } = await listSchedules();
    return { status: health.status, reason: "reason" in health ? health.reason : null,
      heartbeatAt: health.heartbeat?.at.toISOString() ?? null, loadErrors: errors };
  },
  async oneOffs(query, caller) {
    allowed(caller);
    return listOneOffs(query).map(serializeOneOff);
  },
  async cancelOneOff(id, caller) {
    allowed(caller);
    if (!cancelOneOff(id)) throw new BarryError("not_found", `One-off not found: ${id}`);
    return serializeOneOff(getOneOff(id)!);
  },
  async scheduleOnce(input, caller) {
    allowed(caller);
    // HTTP callers meet the wire schema's bound; in-process callers must get the same answer.
    if (input.attempts !== undefined && !(Number.isInteger(input.attempts) && input.attempts >= 1 && input.attempts <= 5))
      throw new BarryError("invalid", `attempts must be a whole number from 1 to 5, not ${input.attempts}`);
    const identity = input.identity !== undefined ? await Barry.as(caller).identity(input.identity).get() : undefined;
    const result = await scheduleOnce({
      action: input.action, inputs: input.inputs, dueAt: input.dueAt instanceof Date ? input.dueAt.toISOString() : input.dueAt,
      ...(identity ? { identity: identity.name } : {}),
      ...(input.traits ? { traits: [...input.traits] } : {}), ...(input.bounds ? { bounds: [...input.bounds] } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attempts !== undefined ? { retry: { attempts: input.attempts } } : {}),
    }, identity?.id);
    return serializeOneOff(result.oneOff);
  },
};
