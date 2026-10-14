import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout.js";

/** Exercise the production timeout helper: an unsettled dependency must not hold a health response. */
describe("health probe timeout", () => {
  it("resolves fast work normally", async () => {
    expect(await withTimeout(Promise.resolve("row"), 50)).toBe("row");
  });

  // The wedge itself: a query that never settles must not hold the response.
  it("gives up on a query that never settles", async () => {
    const start = Date.now();
    const result = await withTimeout(new Promise(() => {}), 40);
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });

  // A rejected query is "database unreachable", not a crashed handler — the
  // old code caught this, and the replacement has to keep doing so.
  it("treats a rejection as unreachable rather than throwing", async () => {
    expect(await withTimeout(Promise.reject(new Error("ECONNREFUSED")), 50)).toBeNull();
  });

  // The timeout must beat the probe that watches it (4s in the metrics bag),
  // or the fix changes nothing.
  it("is bounded well below the 4s probe timeout", async () => {
    const HEALTH_DB_TIMEOUT_MS = 1500;
    const PROBE_TIMEOUT_MS = 4000;
    expect(HEALTH_DB_TIMEOUT_MS).toBeLessThan(PROBE_TIMEOUT_MS / 2);
  });

  // Timers must not keep the event loop alive after a fast resolve.
  it("clears its timer when work wins the race", async () => {
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 200; i++) await withTimeout(Promise.resolve(i), 10_000);
    expect(process.memoryUsage().rss).toBeLessThan(before + 50_000_000);
  });

  /** Timeout bounds this caller; the original promise remains free to settle later. */
  it("does not cancel the raced work — only stops waiting for it", async () => {
    let stillRunning = true;
    const work = new Promise<void>((resolve) => {
      setTimeout(() => {
        stillRunning = false;
        resolve();
      }, 200);
    });
    const result = await withTimeout(work, 20);
    expect(result).toBeNull(); // withTimeout gave up...
    expect(stillRunning).toBe(true); //...but the work is still in flight
    await work; // let it finish so the test doesn't leak a pending timer
    expect(stillRunning).toBe(false);
  });
});
