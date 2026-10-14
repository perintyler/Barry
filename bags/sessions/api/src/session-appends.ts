/** Tail of each session's appends made through `inSessionOrder` in this process. */
const appendQueues = new Map<string, Promise<unknown>>();

/**
 * Run `append` after every append this process started through here for the
 * session before it. Hooks and telemetry arrive concurrently, and the store
 * numbers a message when its insert runs, so overlapping appends would be
 * numbered in whichever order their awaits happened to finish rather than the
 * order they arrived; and a tool_result must not be looked up while its
 * tool_call is still being inserted.
 */
export function inSessionOrder<T>(sessionId: string, append: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(sessionId) ?? Promise.resolve();
  // A failed append must not poison the session's chain.
  const next = previous.catch(() => {}).then(append);
  appendQueues.set(sessionId, next);
  void next.catch(() => {}).then(() => {
    if (appendQueues.get(sessionId) === next) appendQueues.delete(sessionId);
  });
  return next;
}
