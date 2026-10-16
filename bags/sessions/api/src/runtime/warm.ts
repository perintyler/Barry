import { claudeProcessCount } from "./process-count.js";
import { rmSync } from "node:fs";
import { forgetSession } from "../db.js";
import { log, type ActiveSession, type SessionRuntime } from "../session-runtime.js";

export function removeWarmAssets(active: ActiveSession): void {
  for (const path of [active.skillsPluginDir, active.commandsDir]) {
    if (path) try { rmSync(path, { recursive: true, force: true }); } catch { /* Temporary assets. */ }
  }
  active.skillsPluginDir = null;
  active.commandsDir = null;
}

/** Prepare this exact session. Concurrent callers and the first turn share one open. */
export function rt_warmHarness(rt: SessionRuntime, id: string): Promise<void> {
  const active = rt.activeSessions.get(id);
  if (active?.session?.isWarm?.()===false && active.warm && !active.abortController && !active.pendingTurns) delete active.warm.preparedAt;
  if (!active || active.warm?.preparedAt !== undefined) return Promise.resolve();
  if (active.warming) return active.warming;
  const generation = active.generation;
  const warmGeneration = active.warmGeneration ?? 0;
  const stale = () => rt.isStale(active, generation) || (active.warmGeneration ?? 0) !== warmGeneration;
  const warming:Promise<void> = (async () => {
    try {
      const env = await rt.resolveHarnessEnvironment(active);
      if (stale()) return;
      const session = await rt.ensureHarnessSession(active, active.mcpServers, env);
      if (stale()) { await session.close(); if (active.session === session) active.session = null; return; }
      const start = performance.now();
      await session.warm?.();
      if (stale()) { await session.close(); if (active.session === session) active.session = null; return; }
      active.timings.harness_ready_ms = performance.now() - start;
      active.timings.warm_hit=session.isWarm?.()===true?1:0;
      active.warm = { preparedAt: Date.now(), ...(active.subscribers.size ? {} : { idleSince: Date.now() }) };
      if (!active.pendingTurns && !active.abortController) active.status = "waiting";
      rt.broadcastToSession(id, { type: "status", sessionId: id, status: active.status, metadata: { warm: true, timing: { ...active.timings } } });
      log.info("session.warm_ready", { sessionId: id, ...active.timings });
    } catch (error) {
      if (!stale()) {
        const failed = active.session;
        active.session = null;
        await failed?.close().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        active.warm = { error: message, idleSince: Date.now() };
        active.status = active.pendingTurns || active.abortController ? "streaming" : "waiting";
        void claudeProcessCount().then(claude_processes=>log.warn("session.warm_failed", { sessionId: id, error: message, claude_processes }));
      }
    } finally {
      if (rt.activeSessions.get(id)!==active) removeWarmAssets(active);
    }
  })().finally(()=>{if(active.warming===warming)active.warming=null;});
  active.warming = warming;
  return warming;
}

/** Discard an unused resident configuration while retaining its durable session row. */
export async function rt_dropResident(rt: SessionRuntime, id: string, options: { force?: boolean } = {}): Promise<ActiveSession | null> {
  const active = rt.activeSessions.get(id);
  if (!active || active.lastSequence >= 0 || active.pendingTurns || active.abortController || (!options.force && (active.renderers.size || active.subscribers.size))) return null;
  active.generation++;
  rt.activeSessions.delete(id);
  rt.residentBudget.releaseById(id);
  await active.warming;
  await active.opening?.catch(() => {});
  await active.session?.close().catch(() => {});
  active.session = null;
  removeWarmAssets(active);
  forgetSession(id);
  return active;
}
