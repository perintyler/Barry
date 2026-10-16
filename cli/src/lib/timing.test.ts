import { describe, expect, it, vi } from "vitest";
import { createTiming } from "./timing.js";

describe("launch timing", () => {
  it("reports ordered marks and a span with nonnegative durations once", async () => {
    const write = vi.fn();
    const timing = createTiming(true, write);
    timing.mark("test:first");
    expect(await timing.span("test:work", async () => 42)).toBe(42);
    timing.mark("test:last");
    timing.report("handoff");
    timing.report("exit");
    expect(write).toHaveBeenCalledOnce();
    const table = write.mock.calls[0][0];
    expect(table).toContain("entry:");
    expect(table.indexOf("test:first")).toBeLessThan(table.indexOf("test:work"));
    expect(table.indexOf("test:work")).toBeLessThan(table.indexOf("test:last"));
    for (const line of table.split("\n").filter((line: string) => line.startsWith("test:"))) {
      const [, start, duration] = line.trim().split(/\s+/);
      expect(Number(start)).toBeGreaterThanOrEqual(0);
      expect(Number(duration)).toBeGreaterThanOrEqual(0);
    }
  });
  it("records a rejected span without changing the error", async () => {
    const write = vi.fn();
    const timing = createTiming(true, write);
    const error = new Error("failure");
    await expect(timing.span("test:failed", async () => { throw error; })).rejects.toBe(error);
    timing.report("failed");
    expect(write.mock.calls[0][0]).toContain("test:failed");
  });
  it("does no reporting or performance work when disabled", async () => {
    const write = vi.fn();
    const before = performance.getEntries().length;
    const timing = createTiming(false, write);
    timing.mark("disabled");
    expect(await timing.span("disabled:work", async () => 7)).toBe(7);
    timing.report("exit");
    timing.server({ warm_hit: 1 });
    expect(performance.getEntries()).toHaveLength(before);
    expect(write).not.toHaveBeenCalled();
  });
});
