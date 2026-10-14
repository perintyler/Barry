import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invalidateAuthorizationChanges, watchAuthorizationChanges } from "./authorization-changes.js";

let directory: string;
const subscriptions: Array<() => void> = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "barry-authorization-watch-")); });
afterEach(() => { for (const close of subscriptions.splice(0)) close(); rmSync(directory, { recursive: true, force: true }); });
it("does not create a missing store or directory when notifications are unavailable", () => {
  const path = join(directory, "missing", "identities.db");
  subscriptions.push(watchAuthorizationChanges(path, vi.fn()));
  expect(existsSync(join(directory, "missing"))).toBe(false);
});
it("isolates listener failures and releases a subscription independently and idempotently", async () => {
  const path = join(directory, "identities.db");
  const bad = vi.fn(() => { throw new Error("Listener unavailable"); });
  const good = vi.fn();
  subscriptions.push(watchAuthorizationChanges(path, bad));
  const close = watchAuthorizationChanges(path, good); subscriptions.push(close);
  invalidateAuthorizationChanges(path);
  await Promise.resolve();
  expect(bad).toHaveBeenCalledOnce(); expect(good).toHaveBeenCalledOnce();
  close(); close();
  invalidateAuthorizationChanges(path);
  await Promise.resolve();
  expect(bad).toHaveBeenCalledTimes(2); expect(good).toHaveBeenCalledOnce();
});
it("filters unrelated directory changes while detecting WAL replacement", async () => {
  const path = join(directory, "identities.db");
  const listener = vi.fn();
  subscriptions.push(watchAuthorizationChanges(path, listener));
  writeFileSync(join(directory, "unrelated.db-wal"), "unrelated");
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(listener).not.toHaveBeenCalled();
  writeFileSync(`${path}-wal`, "new WAL");
  await vi.waitFor(() => expect(listener).toHaveBeenCalled());
});
it("isolates asynchronous listener rejection without skipping other services", async () => {
  const path = join(directory, "identities.db");
  const listener = vi.fn();
  subscriptions.push(watchAuthorizationChanges(path, async () => { throw new Error("Async consumer unavailable"); }));
  subscriptions.push(watchAuthorizationChanges(path, listener));
  invalidateAuthorizationChanges(path);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
});
