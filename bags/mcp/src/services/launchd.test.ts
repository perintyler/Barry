import { expect, it, vi } from "vitest";
import { launchd } from "./launchd.js";
it("observes launchd execution separately from automatic policy and propagates permission errors", () => {
  const calls: string[][] = [];
  const os = launchd(args => {
    calls.push([...args]);
    if (args[0] === "print-disabled") return '"rocks.barry.fixture.api" => true';
    if (args[0] === "print") return "state = running\npid = 501\nruns = 4\nlast exit code = 1\n";
    throw new Error("permission denied");
  });
  expect(calls).toEqual([]);
  expect(os.inspect("gui/501", "rocks.barry.fixture.api")).toMatchObject({ pid: 501, loaded: true, runs: 4, lastExitCode: 1 });
  expect(os.policy!("gui/501", "rocks.barry.fixture.api")).toBe(false);
  expect(os.policy!("gui/501", "rocksXbarryXfixtureXapi")).toBe(true);
  expect(() => os.load("system", "/fixture/job.plist")).toThrow("permission denied");
  expect(() => launchd(() => { throw new Error("not permitted"); }).inspect("system", "fixture")).toThrow("not permitted");
  expect(launchd(() => { throw new Error("Could not find service"); }).inspect("gui/501", "fixture")).toEqual({ loaded: false });
});

it("permits system control only for root, and GUI control for both users", () => {
  const uid = vi.spyOn(process, "getuid");
  try {
    const os = launchd(() => { throw new Error("unexpected OS call"); });
    uid.mockReturnValue(501); expect(os.canControl!("system")).toBe(false); expect(os.canControl!("gui/501")).toBe(true);
    uid.mockReturnValue(0); expect(os.canControl!("system")).toBe(true); expect(os.canControl!("gui/501")).toBe(true);
  } finally { uid.mockRestore(); }
});

it("observes asynchronously with the same parsing and absence rules", async () => {
  const os = launchd(() => "pid = 501\nruns = 4\nlast exit code = -1\n");
  expect(await os.observe!("gui/501", "fixture")).toMatchObject({ loaded: true, pid: 501, runs: 4, lastExitCode: -1 });
  expect(await launchd(() => { throw new Error("Could not find service"); }).observe!("gui/501", "fixture")).toEqual({ loaded: false });
  await expect(launchd(() => { throw new Error("permission denied"); }).observe!("system", "fixture")).rejects.toThrow("permission denied");
});

it("kills a stalled async observation at its subprocess deadline", async () => {
  const childProcess = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(childProcess.execFile);
  vi.doMock("node:child_process", () => {
    const execFile = vi.fn();
    Object.defineProperty(execFile, promisify.custom, { value: async (_path: string, _args: string[], options: { timeout: number; killSignal: NodeJS.Signals }) => {
      expect(options).toMatchObject({ timeout: 5000, killSignal: "SIGKILL" });
      return execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 20 });
    } });
    return { ...childProcess, execFile };
  });
  vi.resetModules();
  try {
    const { launchd: observedLaunchd } = await import("./launchd.js");
    await expect(observedLaunchd().observe!("gui/501", "fixture")).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
  } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
});


it("selects launchd only on Darwin with launchctl and keeps unsupported policy inert", async () => {
  const { serviceOS } = await import("./launchd.js");
  const os = serviceOS("linux", () => true);
  expect(os.canControl!("system")).toBe(false);
  expect(os.canControl!("gui/501")).toBe(true);
  expect(os.inspect("gui/501", "fixture")).toEqual({ loaded: false, state: "unsupported" });
  os.enable("gui/501", "fixture", true);
  expect(os.policy!("gui/501", "fixture")).toBe(true);
  expect(() => os.load("gui/501", "fixture")).toThrow("services need launchd or systemd");
  expect(() => os.start("gui/501", "fixture")).toThrow("services need launchd or systemd");
  await expect(os.unload("gui/501", "fixture", 1)).rejects.toMatchObject({ reason: "unsupported" });
  expect(serviceOS("darwin", () => false).inspect("gui/501", "fixture").state).toBe("unsupported");
  expect(serviceOS("darwin", () => true).observe).toBeTypeOf("function");
});
