import { it, expect, vi, afterEach } from "vitest";
import { WorkflowAuthorization } from "./workflow-authorization.js";

afterEach(() => vi.useRealTimers());

it("keeps the original bearer and rechecks current authority", async () => {
  let valid = true;
  const verify = vi.fn(async (token: string) => {
    expect(token).toBe("original");
    if (!valid) throw new Error("private-detail");
  });
  const authorization = new WorkflowAuthorization("original", verify);
  expect(await authorization.check()).toBe(true);
  valid = false; expect(await authorization.check()).toBe(false);
  authorization.dispose(); expect(await authorization.check()).toBe(false);
  expect(verify).toHaveBeenCalledTimes(2);
});

it.each(["caller", "lifetime"])("cancels pending verification on %s disposal and ignores late success", async source => {
  let finish!: () => void;
  let started!: () => void;
  let active!: AbortSignal;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const authorization = new WorkflowAuthorization("original", async (_token, signal) => {
    active = signal; started(); await new Promise<void>(resolve => { finish = resolve; });
  });
  const caller = new AbortController();
  const result = authorization.check(caller.signal);
  await ready;
  if (source === "caller") caller.abort(); else authorization.dispose();
  expect(await result).toBe(false); expect(active.aborted).toBe(true);
  finish(); await Promise.resolve();
  authorization.dispose(); expect(await authorization.check()).toBe(false);
});

it("refuses an already cancelled caller without invoking verification", async () => {
  const verify = vi.fn(async () => {});
  const authorization = new WorkflowAuthorization("original", verify);
  const caller = new AbortController(); caller.abort();
  expect(await authorization.check(caller.signal)).toBe(false);
  expect(verify).not.toHaveBeenCalled(); authorization.dispose();
});

it("bounds an uncooperative verifier", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const authorization = new WorkflowAuthorization("original", async () => new Promise<void>(() => {}), 20);
  const result = authorization.check();
  await vi.advanceTimersByTimeAsync(21);
  expect(await result).toBe(false); authorization.dispose();
});

it("checks the monotonic deadline after a synchronous verifier returns", async () => {
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let signal!: AbortSignal;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  const authorization = new WorkflowAuthorization("original", async (_token, active) => { signal = active; elapsed = 5001; });
  try { expect(await authorization.check()).toBe(false); expect(signal.aborted).toBe(true); }
  finally { clock.mockRestore(); authorization.dispose(); }
});
