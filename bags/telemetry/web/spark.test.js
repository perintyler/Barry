import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { schedulePolling } from "./spark.js";

// Stub the minimal DOM contract to test visibility-driven polling without a browser dependency.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-243
function fakeDocument(initialState = "visible") {
  const listeners = new Set();
  return {
    visibilityState: initialState,
    addEventListener(type, fn) {
      if (type === "visibilitychange") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "visibilitychange") listeners.delete(fn);
    },
    setVisibility(state) {
      this.visibilityState = state;
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
}

let originalDocument;

beforeEach(() => {
  originalDocument = globalThis.document;
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.document = originalDocument;
  vi.useRealTimers();
});

describe("schedulePolling", () => {
  it("refreshes immediately, then again after the interval", async () => {
    globalThis.document = fakeDocument("visible");
    const refresh = vi.fn().mockResolvedValue(undefined);

    schedulePolling(refresh, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  // Stop polling a backgrounded tab so hidden dashboards do not keep loading the server.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-135
  it("stops polling while the tab is hidden", async () => {
    const doc = fakeDocument("visible");
    globalThis.document = doc;
    const refresh = vi.fn().mockResolvedValue(undefined);

    schedulePolling(refresh, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    doc.setVisibility("hidden");
    // Plenty of intervals' worth of time passing while hidden.
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately on becoming visible again, not after a full interval", async () => {
    const doc = fakeDocument("visible");
    globalThis.document = doc;
    const refresh = vi.fn().mockResolvedValue(undefined);

    schedulePolling(refresh, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    doc.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);

    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops entirely once the returned stop function is called", async () => {
    globalThis.document = fakeDocument("visible");
    const refresh = vi.fn().mockResolvedValue(undefined);

    const stop = schedulePolling(refresh, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Back off failed polling up to the ceiling so a struggling server is not hammered at base cadence.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-244
  it("backs off the interval on repeated failures, capped at maxIntervalMs", async () => {
    globalThis.document = fakeDocument("visible");
    const refresh = vi.fn().mockRejectedValue(new Error("down"));

    // Each failure doubles the wait BEFORE the next call: 2000, then 4000
    // (capped). Waiting less than the doubled amount must NOT have produced
    // the next call yet, proving this is actual backoff and not just "fewer
    // calls over the same span".
    schedulePolling(refresh, 1000, { maxIntervalMs: 4000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1); // t=0, first call always fires immediately

    await vi.advanceTimersByTimeAsync(1999);
    expect(refresh).toHaveBeenCalledTimes(1); // NOT yet 2 — the 1st failure backs off to 2000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2); // t=2000

    await vi.advanceTimersByTimeAsync(3999);
    expect(refresh).toHaveBeenCalledTimes(2); // NOT yet 3 — the 2nd failure backs off to 4000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3); // t=6000

    await vi.advanceTimersByTimeAsync(4000);
    expect(refresh).toHaveBeenCalledTimes(4); // t=10000, stays at the 4000ms ceiling
  });

  it("resets to the base interval after a successful refresh", async () => {
    globalThis.document = fakeDocument("visible");
    let fail = true;
    const refresh = vi.fn(async () => {
      if (fail) throw new Error("down");
    });

    schedulePolling(refresh, 1000, { maxIntervalMs: 8000 });
    await vi.advanceTimersByTimeAsync(0); // call 1 (fails), backs off to 2000ms
    await vi.advanceTimersByTimeAsync(2000); // call 2 (fails), backs off to 4000ms
    expect(refresh).toHaveBeenCalledTimes(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(4000); // call 3, succeeds -> resets to 1000ms
    expect(refresh).toHaveBeenCalledTimes(3);

    // Proves the reset: a still-backed-off scheduler would need 4000ms+ here,
    // not the base 1000ms, to produce the next call.
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
