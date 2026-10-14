import { afterEach, expect, it, vi } from "vitest";

vi.mock("@barry-rocks/sdk/logging", () => ({ createLogger: () => ({ child: () => ({ info: vi.fn(), error: vi.fn() }) }) }));
const deleteOlderThan = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/sessions-bag/client", () => ({ Messages: { deleteOlderThan } }));
import { startTtlCleanup, stopTtlCleanup } from "./ttl-cleanup.js";

afterEach(() => { stopTtlCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("does not keep the service alive and clears its timer on stop", () => {
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  startTtlCleanup();
  const timer = timeout.mock.results[0].value as NodeJS.Timeout;
  expect(timer.hasRef()).toBe(false);
  stopTtlCleanup();
  expect(clear).toHaveBeenCalledWith(timer);
});

it("does not restart after shutdown during an in-flight cleanup", async () => {
  vi.useFakeTimers();
  let finish!: (result: { deletedRows: number }) => void;
  deleteOlderThan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const timeout = vi.spyOn(globalThis, "setTimeout");
  startTtlCleanup();
  vi.clearAllTimers(); // The callback's timeout has fired, as it would in the service.
  const pending = (timeout.mock.calls[0][0] as () => Promise<void>)();
  expect(deleteOlderThan).toHaveBeenCalled();
  stopTtlCleanup();
  finish({ deletedRows: 0 });
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});

it("starting twice keeps one scheduled cleanup", () => {
  vi.useFakeTimers();
  startTtlCleanup(); startTtlCleanup();
  expect(vi.getTimerCount()).toBe(1);
});
