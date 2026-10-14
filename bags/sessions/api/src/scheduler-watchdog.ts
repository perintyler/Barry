/**
 * Watches the scheduler from outside it.
 *
 * Every scheduled maintenance task — including the service health-check —
 * now runs inside one scheduler process. If that process dies, nothing it
 * runs can say so. The API is a separate, separately kept-alive process, so
 * it reads the scheduler's heartbeat and raises an alert when it goes stale.
 *
 * Alerts on TRANSITIONS (up → down, down → up), so a long outage is one alert
 * and one recovery, not one per minute.
 */

import { createLogger } from "@barry-rocks/sdk/logging";
import { Events } from "@barry-rocks/events-bag";
import { schedulerHealth } from "@barry-rocks/schedules-bag";

const log = createLogger("barry-server");

const CHECK_EVERY_MS = 60_000;
/** Give a freshly started machine time to bring the scheduler up before judging it. */
const STARTUP_GRACE_MS = 3 * 60_000;

export function startSchedulerWatchdog(): NodeJS.Timeout {
  let down = false;
  const check = async () => {
    const health = schedulerHealth();
    const isDown = health.status === "down";
    if (isDown === down) return;
    down = isDown;
    const reason = "reason" in health ? health.reason : "";
    log[isDown ? "error" : "info"]("schedules.scheduler_health", { status: health.status, reason });
    try {
      await Events.create({
        type: isDown ? "system_alert" : "task_finished",
        severity: isDown ? "error" : "success",
        source: "schedules",
        title: isDown ? "Scheduler is down — no schedules are running" : "Scheduler recovered",
        ...(reason ? { body: reason } : {}),
        data: { status: health.status },
      });
    } catch (error) {
      // Leave `down` unflipped so the next check tries to announce again.
      down = !isDown;
      log.error("schedules.watchdog_event_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref();
  setTimeout(() => void check(), STARTUP_GRACE_MS).unref();
  return timer;
}
