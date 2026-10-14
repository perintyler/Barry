import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { withDeadline } from "./with-deadline.js";

describe("withDeadline", () => {
  it("resolves with the operation's value when it completes in time", async () => {
    const value = await withDeadline(async () => 42, {
      timeoutMs: 1000,
      onCancel: () => new Error("cancelled"),
    });
    expect(value).toBe(42);
  });

  it("rejects with onCancel's error when the deadline fires", async () => {
    await expect(
      withDeadline(() => new Promise((resolve) => setTimeout(resolve, 50)), {
        timeoutMs: 5,
        onCancel: () => new Error("timed out"),
      }),
    ).rejects.toThrow("timed out");
  });

  it("rejects when an external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => "ran");
    await expect(
      withDeadline(operation, {
        timeoutMs: 1000,
        signals: [controller.signal],
        onCancel: () => new Error("cancelled"),
      }),
    ).rejects.toThrow("cancelled");
  });

  it("cancels when an external signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = withDeadline(
      (signal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("inner")))),
      { timeoutMs: 1000, signals: [controller.signal], onCancel: () => new Error("cancelled") },
    );
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("cancels on a registered event source and removes its listener afterwards", async () => {
    const source = new EventEmitter();
    const promise = withDeadline(
      () => new Promise<string>(() => {}),
      {
        timeoutMs: 1000,
        events: [{ source, event: "close" }],
        onCancel: () => new Error("closed"),
      },
    );
    source.emit("close");
    await expect(promise).rejects.toThrow("closed");
    // The finally block must detach, or a long-lived source accumulates listeners.
    expect(source.listenerCount("close")).toBe(0);
  });

  it("assertActive throws after an await once the controller has aborted", async () => {
    const controller = new AbortController();
    await expect(
      withDeadline(
        async (_signal, assertActive) => {
          controller.abort();
          await Promise.resolve();
          assertActive();
          return "unreachable";
        },
        { timeoutMs: 1000, signals: [controller.signal], onCancel: () => new Error("cancelled") },
      ),
    ).rejects.toThrow("cancelled");
  });
});
