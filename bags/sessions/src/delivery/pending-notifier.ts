/**
 * Wakes a long-poller the moment a prompt is queued.
 *
 * A wait could be a loop that re-reads the database every second or so, and
 * it still has that loop as a backstop. But a prompt queued in the sessions
 * API, where the waits are held, needs no polling at all: the queue hands the
 * waiter its answer directly. That is the difference between a message
 * landing in ~10 ms and in up to a second, on every hop it serves.
 *
 * The DB recheck stays because this notifier only sees writes in its own
 * process; a prompt queued by any other process is found by the backstop.
 */

type Waiter = (sessionId: string) => void;

export class PendingNotifier {
  private readonly waiters = new Map<string, Set<Waiter>>();

  /**
   * Call `waiter` when a prompt is queued for any of `sessionIds`. Returns the
   * unsubscribe, which the caller MUST run — a waiter left behind after its
   * request has ended is a leak that also delivers a wake to nobody.
   */
  subscribe(sessionIds: readonly string[], waiter: Waiter): () => void {
    for (const id of sessionIds) {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(waiter);
    }
    return () => {
      for (const id of sessionIds) {
        const set = this.waiters.get(id);
        if (!set) continue;
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(id);
      }
    };
  }

  /** A prompt is now pending for this session. */
  notify(sessionId: string): void {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    // Copied before iterating: a waiter unsubscribes itself as it resolves,
    // which mutates this set mid-loop.
    for (const waiter of [...set]) waiter(sessionId);
  }

  /** How many waiters are parked, for the wait endpoint's observability. */
  waiterCount(): number {
    let total = 0;
    for (const set of this.waiters.values()) total += set.size;
    return total;
  }
}
