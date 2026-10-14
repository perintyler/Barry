import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * SDK-16: `child()` must call `pinoLogger.child()`, not construct a fresh
 * `pino()` per child. A per-child instance opens its own destination and is
 * costly; a child is supposed to inherit the parent's sink, level and base.
 *
 * We assert this at the pino boundary: creating N children must create exactly
 * one pino instance (the parent) and call `.child()` on it N times. We also
 * check the merged, redacted context is what gets logged.
 */
describe("createLogger child (SDK-16)", () => {
  afterEach(() => vi.resetModules());

  it("builds one pino instance and uses pino.child for children", async () => {
    const childLog = vi.fn();
    const childInstance = {
      debug: vi.fn(), info: childLog, warn: vi.fn(), error: vi.fn(),
      child: vi.fn(() => childInstance),
    };
    const rootInstance = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(() => childInstance),
    };
    const pinoFactory = Object.assign(vi.fn(() => rootInstance), {
      stdTimeFunctions: { isoTime: () => "" },
      destination: () => ({}),
    });

    vi.resetModules();
    vi.doMock("pino", () => ({ default: pinoFactory }));
    const { createLogger } = await import("./emit.js");

    const log = createLogger("svc", { transport: "stdout" });
    const child = log.child({ requestId: "r1" });
    child.info("hello");
    log.child({ a: "1" }).child({ b: "2" });

    // Exactly one pino() instance for the whole tree.
    expect(pinoFactory).toHaveBeenCalledTimes(1);
    // Three children were created, all via pinoLogger.child(), never new pino().
    expect(rootInstance.child).toHaveBeenCalledTimes(2); // r1 and a
    expect(childInstance.child).toHaveBeenCalledTimes(1); // b (nested on a's child)
    // The child's context is passed to pino, redacted.
    expect(rootInstance.child).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }));
    expect(childLog).toHaveBeenCalled();
  });

  it("redacts secret-shaped keys before handing context to pino.child", async () => {
    const childInstance = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
    };
    const rootInstance = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(() => childInstance),
    };
    const pinoFactory = Object.assign(vi.fn(() => rootInstance), {
      stdTimeFunctions: { isoTime: () => "" },
      destination: () => ({}),
    });

    vi.resetModules();
    vi.doMock("pino", () => ({ default: pinoFactory }));
    const { createLogger } = await import("./emit.js");

    createLogger("svc").child({ password: "hunter2" });

    const passedContext = rootInstance.child.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(passedContext)).not.toContain("hunter2");
  });
});
