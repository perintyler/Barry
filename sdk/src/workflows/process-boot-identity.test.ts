/** Mocked platform/native-output contract tests; actual Darwin TZ behavior is a CLI native case. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
const native = vi.hoisted(() => ({ exec: vi.fn<(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => string>(), read: vi.fn<(path: string, encoding: string) => string>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: native.exec }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: native.read }));
import { processBootIdentity, isCurrentProcessBootIdentity } from "./process-boot-identity.js";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const utc = "{ sec = 1791948282, usec = 164644 } Wed Oct 14 03:24:42 2026";
const caller = "{ sec = 1791948282, usec = 164644 } Tue Oct 13 17:24:42 2026";
const system = "{ sec = 1791948282, usec = 164644 } Tue Oct 13 23:24:42 2026";
const canonical = "darwin:boottime:v1:1791948282:164644";
function platform(value: string) { Object.defineProperty(process, "platform", { ...descriptor, value }); }
beforeEach(() => { platform("darwin");native.exec.mockReset().mockReturnValue(utc + "\n");native.read.mockReset();vi.stubEnv("TZ", "Pacific/Honolulu"); });
afterEach(() => { Object.defineProperty(process, "platform", descriptor);vi.unstubAllEnvs();vi.restoreAllMocks(); });

it("derives the same versioned Darwin identity from the numeric tuple regardless of human date rendering and uses a bounded clean UTC probe", () => {
  expect(processBootIdentity()).toBe(canonical);
  native.exec.mockReturnValue(caller);expect(processBootIdentity()).toBe(canonical);
  native.exec.mockReturnValue(system);expect(processBootIdentity()).toBe(canonical);
  for (const args of native.exec.mock.calls) expect(args).toEqual(["/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }]);
});

it.each(["", "not a native tuple", "{ sec = 0, usec = 0 }", "{ sec = -1, usec = 0 }", "{ sec = 9007199254740992, usec = 0 }", "{ sec = 123, usec = -1 }", "{ sec = 123, usec = 1000000 }", "{ sec = 123 }", "{ sec = NaN, usec = 0 }", "{ sec = 123.5, usec = 0 }", "prefix { sec = 123, usec = 0 }"])("refuses malformed or out-of-range mocked Darwin observation %j", raw => {
  native.exec.mockReturnValue(raw);expect(() => processBootIdentity()).toThrow();expect(isCurrentProcessBootIdentity(canonical)).toBe(false);
});

it("accepts the current canonical tuple without consulting legacy aliases and rejects another canonical tuple", () => {
  expect(isCurrentProcessBootIdentity(canonical)).toBe(true);expect(native.exec).toHaveBeenCalledTimes(1);
  native.exec.mockClear();expect(isCurrentProcessBootIdentity("darwin:boottime:v1:1791948283:164644")).toBe(false);expect(native.exec).toHaveBeenCalledTimes(1);
});

it.each(["utc", "caller", "system"] as const)("accepts a legacy %s hash only when an actual mocked native probe reproduces that raw output from the same tuple", selection => {
  native.exec.mockImplementation((_file: unknown, _args: unknown, options: { env: NodeJS.ProcessEnv }) => options.env.TZ === "UTC" ? utc : options.env.TZ === "Pacific/Honolulu" ? caller : system);
  expect(isCurrentProcessBootIdentity(boundFingerprint({ utc, caller, system }[selection]))).toBe(true);
  expect(native.exec).toHaveBeenCalledTimes({ utc: 1, caller: 2, system: 3 }[selection]);
});

it("bounds unmatched legacy lookup to UTC, the one declared caller timezone and system default without guessing historic timezones", () => {
  native.exec.mockReturnValue(utc);expect(isCurrentProcessBootIdentity("0".repeat(64))).toBe(false);
  expect(native.exec).toHaveBeenCalledTimes(3);
  expect(native.exec.mock.calls.map(args => args[2].env)).toEqual([{ PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "Pacific/Honolulu" }, { PATH: "/usr/bin:/bin", LC_ALL: "C" }]);
});

it("does not repeat the caller alias when its timezone is UTC or absent", () => {
  for (const TZ of ["UTC", undefined]) {
    if (TZ === undefined) delete process.env.TZ;else process.env.TZ = TZ;
    native.exec.mockClear();expect(isCurrentProcessBootIdentity("0".repeat(64))).toBe(false);expect(native.exec).toHaveBeenCalledTimes(2);
  }
});

it("rejects a matching legacy raw hash if its native observation belongs to a different boot tuple", () => {
  const anotherBoot = "{ sec = 1791948283, usec = 164644 } Tue Oct 13 17:24:43 2026";
  native.exec.mockReturnValueOnce(utc).mockReturnValue(anotherBoot);
  expect(isCurrentProcessBootIdentity(boundFingerprint(anotherBoot))).toBe(false);expect(native.exec).toHaveBeenCalledTimes(2);
});

it("fails closed when native lookup throws or an alias has an invalid tuple", () => {
  native.exec.mockImplementation(() => { throw new Error("Mock native lookup unavailable"); });
  expect(() => processBootIdentity()).toThrow("Mock native lookup unavailable");expect(isCurrentProcessBootIdentity(canonical)).toBe(false);
  native.exec.mockReset().mockReturnValueOnce(utc).mockReturnValue("invalid");expect(isCurrentProcessBootIdentity("0".repeat(64))).toBe(false);
});

it("leaves mocked Linux boot_id bytes and exact matching behavior unchanged without any sysctl probe", () => {
  platform("linux");native.read.mockReturnValue("existing-linux-boot-id\n");
  expect(processBootIdentity()).toBe("existing-linux-boot-id");expect(isCurrentProcessBootIdentity("existing-linux-boot-id")).toBe(true);expect(isCurrentProcessBootIdentity("different-linux-boot-id")).toBe(false);
  expect(native.read).toHaveBeenCalledWith("/proc/sys/kernel/random/boot_id", "utf8");expect(native.exec).not.toHaveBeenCalled();
});

it("refuses unsupported mocked platforms and never invokes a native command", () => {
  platform("win32");expect(() => processBootIdentity()).toThrow(/unavailable/);expect(isCurrentProcessBootIdentity(canonical)).toBe(false);expect(native.exec).not.toHaveBeenCalled();expect(native.read).not.toHaveBeenCalled();
});
