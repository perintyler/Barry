import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";

interface Subscription {
  listeners: Set<() => void | Promise<void>>;
  watcher?: FSWatcher;
  queued: boolean;
}
const subscriptions = new Map<string, Subscription>();

function dispatch(subscription: Subscription): void {
  for (const listener of [...subscription.listeners]) {
    try { Promise.resolve(listener()).catch(() => {}); } catch { /* A failed consumer cannot prevent other services from rechecking. */ }
  }
}

function queue(subscription: Subscription): void {
  if (subscription.queued) return;
  subscription.queued = true;
  // A surrounding synchronous transaction must commit or roll back before readers recheck.
  queueMicrotask(() => { subscription.queued = false; dispatch(subscription); });
}

export function invalidateAuthorizationChanges(path: string): void {
  const subscription = subscriptions.get(resolve(path));
  if (subscription) queue(subscription);
}

/** WAL notifications wake other services; periodic verification handles lost filesystem events. */
export function watchAuthorizationChanges(path: string, listener: () => void | Promise<void>): () => void {
  if (path === ":memory:") return () => {};
  const key = resolve(path);
  let subscription = subscriptions.get(key);
  if (!subscription) {
    subscription = { listeners: new Set(), queued: false };
    subscriptions.set(key, subscription);
    const current = subscription;
    const file = basename(key);
    try {
      current.watcher = watch(dirname(key), { persistent: false }, (_event, name) => {
        if (name !== null && name.toString() !== file && name.toString() !== `${file}-wal`) return;
        queue(current);
      });
      current.watcher.on("error", () => {
        current.watcher?.close(); current.watcher = undefined;
        queue(current);
      });
    } catch { /* An unavailable watcher leaves the bounded periodic checks active. */ }
  }
  subscription.listeners.add(listener);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    subscription.listeners.delete(listener);
    if (!subscription.listeners.size) {
      subscription.watcher?.close();
      subscriptions.delete(key);
    }
  };
}
