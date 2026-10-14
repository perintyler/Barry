/**
 * The scheduler service — launched and kept alive by launchd. A composition
 * root: the runners in runners.ts are wired into the Scheduler here.
 */

import { Barry } from "@barry-rocks/sdk";
import { identities } from "@barry-rocks/identities-bag";
import { isScriptAction } from "@barry-rocks/sdk/internal/actions";
import { listSchedules, resolveScheduleAction } from "@barry-rocks/schedules-bag";
import { Scheduler } from "@barry-rocks/schedules-bag";
import { loginEventId } from "@barry-rocks/schedules-bag";
import { processStartTime } from "@barry-rocks/schedules-bag";
import { announce, prune, recoverOneOffs, runAgent, runOneOff, runScript, sweepOrphans } from "./runners.js";
import { runScheduledJob } from "@barry-rocks/schedules-bag";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("schedules.service", { transport: "stderr" });


const TICK_MS = 5_000;
const PRUNE_EVERY_MS = 3_600_000;

async function main(): Promise<void> {
  // What a schedule is granted is composed by the identities subject, answered in-process.
  Barry.use(identities);
  const startedAt = processStartTime(process.pid);
  // Before the orphaned-run sweep: a script one-off killed with its runner is
  // re-queued here, where the sweep would only have closed its run as failed.
  let recovering: Promise<void> = recoverOneOffs();
  await recovering;
  const scheduler = new Scheduler({
    listSchedules,
    resolveAction: resolveScheduleAction,
    runScript: (action, entry) => {
      if (!isScriptAction(action)) throw new Error(`${action.qualifiedName} is not a script action`);
      return runScript(action, entry);
    },
    runAgent,
    runJob: (entry) => runScheduledJob(entry),
    announce,
    runOneOff,
    // The scheduler asks every tick; the lookups are async, so each tick
    // settles what the previous one found rather than blocking on it.
    recoverOneOffs: () => {
      recovering = recovering.then(() => recoverOneOffs()).catch((error: unknown) => {
        diagnostics.error("schedules.recovery_failed", { detail: `schedules: one-off recovery failed: ${error instanceof Error ? error.message : String(error)}` });
      });
    },
    runner: { pid: process.pid, startedAt },
    loginEventId,
    now: () => new Date(),
  });

  await sweepOrphans();
  let lastPrune = 0;
  let stopping = false;

  const loop = async () => {
    while (!stopping) {
      try {
        await scheduler.tick();
        if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = Date.now();
          await prune();
        }
      } catch (error) {
        // A tick that throws (a locked database, a bag that crashed the
        // loader) must not end the loop — but it must be loud, and the
        // heartbeat it failed to write is what the watchdog will see.
        diagnostics.error("schedules.tick_failed", { detail: `schedules: tick failed: ${error instanceof Error ? error.stack : String(error)}` });
      }
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
  };

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`schedules: ${signal}, waiting for ${scheduler.running.length} run(s) to finish\n`);
    // launchd sends SIGKILL after its exit timeout; runs still going then are
    // closed as orphans by the next scheduler's sweep.
    await Promise.allSettled(scheduler.running);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.stdout.write(`schedules: scheduler started (pid ${process.pid})\n`);
  await loop();
}

void main();

