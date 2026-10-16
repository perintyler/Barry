import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
import { CgroupContainment } from "./cgroups.js";
const config = { memoryMaxBytes: 134217728, pidsMax: 32, cpuQuotaPercent: 100 };
const observed = {
  group: "/user.slice/test.scope",
  memory: "134217728",
  swap: "0",
  pids: "32",
  cpu: "100000 100000",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
function linux() {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  mocks.exists.mockReturnValue(true);
}
it("does not infer working containment from the controllers file", () => {
  linux();
  mocks.exec.mockImplementation(() => {
    throw new Error("user manager unavailable");
  });
  const provider = new CgroupContainment(config);
  expect(provider.isAvailable).toBe(false);
  expect(() => provider.wrapSpawn("node", [], { hardened: true })).toThrow(/unavailable/);
});
it.each([
  { memory: "max" },
  { swap: "max" },
  { pids: "max" },
  { cpu: "max 100000" },
  { group: "/uncontained" },
])("refuses an unenforced limit: %j", (mismatch) => {
  linux();
  mocks.exec.mockReturnValue(JSON.stringify({ ...observed, ...mismatch }));
  expect(new CgroupContainment(config).isAvailable).toBe(false);
});
it("advertises support only after observing every configured limit in a real scope", () => {
  linux();
  mocks.exec.mockReturnValue(JSON.stringify(observed));
  expect(new CgroupContainment(config).isAvailable).toBe(true);
  expect(mocks.exec).toHaveBeenCalledWith(
    "systemd-run",
    expect.arrayContaining([
      "MemoryMax=134217728",
      "MemorySwapMax=0",
      "TasksMax=32",
      "CPUQuota=100%",
    ]),
    expect.objectContaining({ timeout: 5000 }),
  );
});
