import { describe, it, expect } from "vitest";
import { CgroupContainment } from "./cgroups.js";

describe("CgroupContainment", () => {
  it("initializes safely and detects non-linux platforms", () => {
    const containment = new CgroupContainment({
      memoryMaxBytes: 128 * 1024 * 1024,
      pidsMax: 32,
      cpuQuotaPercent: 100,
    });
    if (process.platform !== "linux") {
      expect(containment.isAvailable).toBe(false);
      expect(containment.mode).toBe("unsupported");
      const wrapped = containment.wrapSpawn("node", ["app.js"]);
      expect(wrapped).toEqual({ command: "node", args: ["app.js"] });
    }
  });

  it("formats systemd-run invocation with memory, pids and cpu constraints", () => {
    // Test helper instance pretending to be systemd
    const containment = new CgroupContainment({
      memoryMaxBytes: 100 * 1024 * 1024,
      pidsMax: 16,
      cpuQuotaPercent: 50,
    });
    // Force isAvailable and mode for contract testing
    Object.assign(containment, { isAvailable: true, mode: "systemd" });

    const invocation = containment.wrapSpawn("node", ["worker.js"]);
    expect(invocation.command).toBe("systemd-run");
    expect(invocation.args).toContain("--user");
    expect(invocation.args).toContain("--scope");
    expect(invocation.args).toContain("-p");
    expect(invocation.args).toContain(`MemoryMax=${100 * 1024 * 1024}`);
    expect(invocation.args).toContain("MemorySwapMax=0");
    expect(invocation.args.some(arg => arg.startsWith("MemoryHigh="))).toBe(false);
    expect(invocation.args).toContain("TasksMax=16");
    expect(invocation.args).toContain("CPUQuota=50%");
    expect(invocation.args.slice(-2)).toEqual(["node", "worker.js"]);
  });

  it("refuses execution when hardened containment is requested on unsupported platforms", () => {
    const containment = new CgroupContainment({
      memoryMaxBytes: 100 * 1024 * 1024,
    });
    if (process.platform !== "linux") {
      expect(() => containment.wrapSpawn("node", ["worker.js"], { hardened: true })).toThrow(
        /Hardened containment required, but cgroups v2 containment is unavailable/,
      );
    }
  });

  it("allows hardened containment when systemd cgroups v2 is available", () => {
    const containment = new CgroupContainment({
      memoryMaxBytes: 100 * 1024 * 1024,
    });
    Object.assign(containment, { isAvailable: true, mode: "systemd" });
    const invocation = containment.wrapSpawn("node", ["worker.js"], { hardened: true });
    expect(invocation.command).toBe("systemd-run");
  });
});
