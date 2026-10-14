/**
 * One cancellation race, used wherever the SDK bounds an authorization check
 * by a deadline AND a set of external abort signals.
 *
 * The pattern was copied three times across the auth code (credential
 * revalidation, request authorization, request re-check), each with slightly
 * different cleanup, and three copies of a cancellation race is three places to
 * get the "cancelled vs timed out vs rejected" distinction wrong. This is the
 * single implementation they share.
 *
 * Semantics:
 * - A fresh `AbortController` bounds the operation. It aborts when the timer
 *   fires, when any external signal aborts, or when any registered event source
 *   emits (e.g. a request's `aborted`, a response's `close`).
 * - `operation` receives that controller's signal and an `assertActive()` that
 *   throws if the deadline has passed or the controller aborted — the hook a
 *   verifier that ignores its signal still needs to fail closed after an await.
 * - On cancellation the returned promise rejects with `onCancel()`'s error, so
 *   each caller keeps its own message ("unavailable" vs "cancelled").
 * - Every listener and the timer are removed in `finally`, regardless of
 *   outcome, so a long-lived parent signal does not accumulate listeners.
 */

export interface DeadlineEventSource {
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface WithDeadlineOptions {
  timeoutMs: number;
  /** External AbortSignals that must also cancel the operation. */
  signals?: readonly (AbortSignal | undefined)[];
  /** Node EventEmitter-style sources whose named event cancels the operation. */
  events?: readonly { source: DeadlineEventSource; event: string }[];
  /** The error to reject with when the operation is cancelled or times out. */
  onCancel: () => Error;
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal, assertActive: () => void) => Promise<T>,
  options: WithDeadlineOptions,
): Promise<T> {
  const { timeoutMs, signals = [], events = [], onCancel } = options;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const cancel = () => controller.abort();

  for (const signal of signals) signal?.addEventListener("abort", cancel, { once: true });
  for (const { source, event } of events) source.once(event, cancel);
  const timer = setTimeout(cancel, timeoutMs);

  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(onCancel());
    controller.signal.addEventListener("abort", abort, { once: true });
  });

  const assertActive = () => {
    if (performance.now() >= deadline) cancel();
    controller.signal.throwIfAborted();
  };

  try {
    // If any source is already aborted, cancel before touching the operation.
    if (signals.some((signal) => signal?.aborted)) cancel();
    return await Promise.race([
      Promise.resolve().then(async () => {
        assertActive();
        const result = await operation(controller.signal, assertActive);
        assertActive();
        return result;
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal?.removeEventListener("abort", cancel);
    for (const { source, event } of events) source.removeListener(event, cancel);
    controller.signal.removeEventListener("abort", abort);
  }
}
