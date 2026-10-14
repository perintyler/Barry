/**
 * The delivery state every process asks this one for: which surfaces are
 * listening for each session, the wake budget that stops sessions waking each
 * other in a loop, and the waiters parked on a session's inbox.
 *
 * Per-process by nature, so it lives in the one always-on process. This API
 * installs it with `hostDelivery` (its own code then calls it in-process) and
 * serves it to every other process at `/api/v1/prompts/*` (`routes/prompts.ts`).
 */

import { getPrompts, type Delivery } from "@barry-rocks/sessions-bag/client";
import { ListenerRegistry, PendingNotifier, WakeBudget, type BudgetVerdict } from "@barry-rocks/sessions-bag/delivery";

/**
 * How often a waiter re-reads the store. A prompt queued in this process
 * wakes its waiters at once; one queued by any other process (they write the
 * store directly) is found by this read, so it bounds how late that one is.
 */
const PROMPT_RECHECK_MS = 1_000;

export interface DeliveryHost extends Delivery {
  /** Would a wake be allowed now? Unlike `recordWake`, consumes nothing. */
  checkWake(sessionId: string, fromSession?: string | null): BudgetVerdict;
}

export function createDelivery(
  hasPending: (sessionId: string) => Promise<boolean> = async (sessionId) => (await getPrompts(sessionId)).length > 0,
): DeliveryHost {
  const notifier = new PendingNotifier();
  const listeners = new ListenerRegistry();
  const wakeBudget = new WakeBudget();

  return {
    async waitForPrompts(sessionIds, timeoutMs, signal) {
      const ids = [...new Set(sessionIds)];
      if (ids.length === 0) return [];
      const deadline = Date.now() + timeoutMs;
      const notified = new Set<string>();
      let wake = () => {};
      // Subscribed before the first read, so a prompt queued between the read
      // and the subscription cannot be missed.
      const unsubscribe = notifier.subscribe(ids, (id) => { notified.add(id); wake(); });
      const aborted = () => wake();
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        for (;;) {
          if (notified.size) return [...notified];
          const ready: string[] = [];
          for (const id of ids) if (await hasPending(id)) ready.push(id);
          if (ready.length || notified.size) return [...new Set([...notified, ...ready])];
          const remaining = deadline - Date.now();
          if (remaining <= 0 || signal?.aborted) return [];
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(PROMPT_RECHECK_MS, remaining));
            wake = () => { clearTimeout(timer); resolve(); };
          });
          wake = () => {};
        }
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", aborted);
      }
    },
    async registerListener(sessionId, kind, guarantee) {
      listeners.register(sessionId, kind, guarantee);
    },
    async unregisterListener(sessionId, kind) {
      listeners.unregister(sessionId, kind);
    },
    async getListeners(sessionIds) {
      return Object.fromEntries(sessionIds.map((id) => [id, { guarantee: listeners.guaranteeFor(id), listeners: listeners.forSession(id) }]));
    },
    // One step rather than check-then-record: two surfaces asking at once
    // would both see room and both wake, which is the loop this guards.
    async recordWake(sessionId, fromSession) {
      const verdict = wakeBudget.check(sessionId, fromSession);
      if (verdict.allowed) wakeBudget.record(sessionId, fromSession);
      return verdict;
    },
    checkWake(sessionId, fromSession) {
      return wakeBudget.check(sessionId, fromSession);
    },
    promptQueued(sessionId) {
      notifier.notify(sessionId);
    },
  };
}
