import { it, expect, vi, afterEach } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TransportDelivery } from "./transport-delivery.js";

afterEach(() => vi.useRealTimers());
const frame = (id: number) => ({ jsonrpc: "2.0" as const, id, result: {} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(authorize: () => Promise<boolean>, write: Transport["send"], limits = {}) {
  const rejected = vi.fn();
  const transport: Transport = { start: async () => {}, close: async () => {}, send: write };
  return { delivery: new TransportDelivery(transport, authorize, rejected, limits), rejected };
}

it("preserves frame order and rechecks authority after a blocked send", async () => {
  const blocked = deferred<void>();
  const started = deferred<void>();
  const sent: number[] = [];
  let allowed = true;
  const { delivery, rejected } = fixture(async () => allowed, async message => {
    sent.push(Number("id" in message ? message.id : 0)); started.resolve(); await blocked.promise;
  });
  const first = delivery.send(frame(1));
  const second = delivery.send(frame(2));
  const outcome = second.catch(error => error.message);
  await started.promise;
  expect(sent).toEqual([1]);
  allowed = false; blocked.resolve();
  await first;
  expect(await outcome).toBe("Transport unavailable");
  expect(sent).toEqual([1]); expect(rejected).toHaveBeenCalledTimes(1);
});

it("delivers allowed frames in order without retaining mutable caller data", async () => {
  const blocked = deferred<void>();
  const started = deferred<void>();
  const sent: unknown[] = [];
  const callback = vi.fn();
  const replacement = vi.fn();
  const { delivery } = fixture(async () => true, async (message, options) => {
    sent.push(message); options?.onresumptiontoken?.("next"); started.resolve(); await blocked.promise;
  });
  const first = delivery.send(frame(1));
  const queued = frame(2);
  const options = { onresumptiontoken: callback };
  const second = delivery.send(queued, options);
  options.onresumptiontoken = replacement;
  queued.id = 99; queued.result = { text: "changed" };
  await started.promise; blocked.resolve(); await Promise.all([first, second]);
  expect(sent).toEqual([frame(1), frame(2)]);
  expect(callback).toHaveBeenCalledWith("next"); expect(replacement).not.toHaveBeenCalled();
  delivery.close();
});

it("settles active and queued sends when closed during an uncooperative write", async () => {
  const started = deferred<void>();
  const write = vi.fn(async () => { started.resolve(); await new Promise<void>(() => {}); });
  const { delivery, rejected } = fixture(async () => true, write);
  const outcomes = [delivery.send(frame(1)), delivery.send(frame(2))].map(result => result.catch(error => error.message));
  await started.promise; delivery.close();
  expect(await Promise.all(outcomes)).toEqual(["Transport unavailable", "Transport unavailable"]);
  expect(write).toHaveBeenCalledTimes(1); expect(rejected).not.toHaveBeenCalled();
});

it("never calls the writer when closed during delayed authorization", async () => {
  const authorization = deferred<boolean>();
  const write = vi.fn(async () => {});
  const { delivery } = fixture(() => authorization.promise, write);
  const result = delivery.send(frame(1)).catch(error => error.message);
  delivery.close(); authorization.resolve(true);
  expect(await result).toBe("Transport unavailable");
  await Promise.resolve(); expect(write).not.toHaveBeenCalled();
});

it.each(["messages", "bytes"])("bounds retained %s including the active frame", async limit => {
  const started = deferred<void>();
  const write = vi.fn(async () => { started.resolve(); await new Promise<void>(() => {}); });
  const limits = limit === "messages" ? { messages: 1 } : { bytes: Buffer.byteLength(JSON.stringify([frame(1)])) };
  const { delivery, rejected } = fixture(async () => true, write, limits);
  const first = delivery.send(frame(1)).catch(error => error.message);
  await started.promise;
  const second = delivery.send(frame(2)).catch(error => error.message);
  expect(await Promise.all([first, second])).toEqual(["Transport unavailable", "Transport unavailable"]);
  expect(write).toHaveBeenCalledTimes(1); expect(rejected).toHaveBeenCalledTimes(1);
});

it("ends a stalled send at its deadline and redacts transport failures", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { delivery, rejected } = fixture(async () => true, async () => new Promise<void>(() => {}), { timeoutMs: 20 });
  const result = delivery.send(frame(1)).catch(error => error.message);
  await vi.advanceTimersByTimeAsync(21);
  expect(await result).toBe("Transport unavailable"); expect(rejected).toHaveBeenCalledTimes(1);
  const failed = fixture(async () => true, async () => { throw new Error("private-upstream-detail"); });
  await expect(failed.delivery.send(frame(1))).rejects.toThrow(/^Transport unavailable$/);
});

it("uses one deadline across authorization and writing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const authorization = deferred<boolean>();
  const write = vi.fn(async () => new Promise<void>(() => {}));
  const { delivery } = fixture(() => authorization.promise, write, { timeoutMs: 20 });
  const settled = vi.fn();
  const result = delivery.send(frame(1)).catch(error => error.message);
  void result.then(settled);
  try {
    await vi.advanceTimersByTimeAsync(11);
    authorization.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toHaveBeenCalledWith("Transport unavailable");
  } finally { delivery.close(); await result; }
});

it("includes routing metadata in the byte budget", async () => {
  const write = vi.fn(async () => {});
  const { delivery, rejected } = fixture(async () => true, write, { bytes: 128 });
  await expect(delivery.send(frame(1), { relatedRequestId: "x".repeat(200) })).rejects.toThrow("Transport unavailable");
  expect(write).not.toHaveBeenCalled(); expect(rejected).toHaveBeenCalledTimes(1);
});
