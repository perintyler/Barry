/** Synthetic Mach-O/OS metadata parser units only. No actual native program,
 * compiler, mount probe or cessation behavior is executed by these tests. */
import { beforeEach, expect, it, vi } from "vitest";
import { assertWorkflowRuntimeNativeFiles, isWorkflowRuntimeNativeImage, workflowRuntimeNativeIdentity } from "./workflow-runtime-native.js";

const host = vi.hoisted(() => ({ platform: "darwin", architecture: "arm64", kernel: "synthetic-kernel", mount: "/dev/synthetic on / (apfs, sealed, local, read-only)\n", build: "SYNTHETIC.1\n", failure: false }));
vi.mock("node:os", () => ({ platform: () => host.platform, arch: () => host.architecture, release: () => host.kernel }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn((file: string) => {
  if (host.failure) throw new Error("synthetic metadata probe failed");
  if (file === "/sbin/mount") return host.mount;
  if (file === "/usr/bin/sw_vers") return host.build;
  throw new Error("Unexpected native metadata command");
}) }));
beforeEach(() => { Object.assign(host, { platform: "darwin", architecture: "arm64", kernel: "synthetic-kernel", mount: "/dev/synthetic on / (apfs, sealed, local, read-only)\n", build: "SYNTHETIC.1\n", failure: false });vi.clearAllMocks(); });
const ARM64 = 0x0100000c, X64 = 0x01000007, runtime = "/retained/runtime/node";
function load(path: string, command = 0xc): Buffer {
  const name = Buffer.from(path + "\0"), size = Math.ceil((24 + name.length) / 8) * 8, bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(command, 0);bytes.writeUInt32LE(size, 4);bytes.writeUInt32LE(24, 8);name.copy(bytes, 24);return bytes;
}
function image(architecture = ARM64, commands: Buffer[] = [load("/usr/lib/libSystem.B.dylib")]): Buffer {
  const bytes = Buffer.alloc(32 + commands.reduce((sum, command) => sum + command.length, 0));
  bytes.writeUInt32LE(0xfeedfacf, 0);bytes.writeUInt32LE(architecture, 4);bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(commands.length, 16);bytes.writeUInt32LE(bytes.length - 32, 20);
  let offset = 32;for (const command of commands) { command.copy(bytes, offset);offset += command.length; }return bytes;
}
function fat(slices: { architecture: number; bytes: Buffer }[], wide = false): Buffer {
  const stride = wide ? 32 : 20, header = 8 + slices.length * stride, bytes = Buffer.alloc(header + slices.reduce((sum, slice) => sum + slice.bytes.length, 0));
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);bytes.writeUInt32BE(slices.length, 4);
  let offset = header;
  slices.forEach((slice, index) => {
    const at = 8 + index * stride;bytes.writeUInt32BE(slice.architecture, at);
    if (wide) { bytes.writeBigUInt64BE(BigInt(offset), at + 8);bytes.writeBigUInt64BE(BigInt(slice.bytes.length), at + 16); }
    else { bytes.writeUInt32BE(offset, at + 8);bytes.writeUInt32BE(slice.bytes.length, at + 12); }
    slice.bytes.copy(bytes, offset);offset += slice.bytes.length;
  });return bytes;
}
function accept(files: { source: string; bytes: Buffer }[] = [{ source: runtime, bytes: image() }], identity = workflowRuntimeNativeIdentity()): void { assertWorkflowRuntimeNativeFiles(files, runtime, identity); }

it("binds synthetic sealed OS build, kernel and architecture without executing a retained image", () => {
  const identity = workflowRuntimeNativeIdentity();
  expect(JSON.parse(identity)).toEqual({ platform: "darwin", arch: "arm64", kernel: "synthetic-kernel", sealedSystemBuild: "SYNTHETIC.1" });
  expect(() => accept()).not.toThrow();host.build = "SYNTHETIC.2\n";
  expect(() => accept([{ source: runtime, bytes: image() }], identity)).toThrow("WorkflowRuntimeSystemMappingChanged");
});
it.each(["/dev/synthetic on / (apfs, local, read-only)\n", "/dev/synthetic on / (apfs, unsealed, read-only)\n", "/dev/synthetic on / (apfs, sealed, local)\n"])("refuses an unsupported synthetic root mapping %s", mount => {
  host.mount = mount;expect(() => workflowRuntimeNativeIdentity()).toThrow("WorkflowRuntimeSystemMappingUnsupported");
});
it("refuses unsupported platform, failed system metadata and malformed OS build", () => {
  host.platform = "linux";expect(() => workflowRuntimeNativeIdentity()).toThrow("WorkflowRuntimeNativePlatformUnsupported");
  host.platform = "darwin";host.failure = true;expect(() => workflowRuntimeNativeIdentity()).toThrow("synthetic metadata probe failed");
  host.failure = false;host.build = "bad build/escape";expect(() => workflowRuntimeNativeIdentity()).toThrow("WorkflowRuntimeSystemMappingUnsupported");
});
it.each(["@rpath/libforeign.dylib", "@loader_path/libforeign.dylib", "/opt/homebrew/lib/libforeign.dylib", "/usr/lib/../local/libforeign.dylib", "/System/Library/./foreign"])("rejects selected-architecture custom or escaping native dependency %s", dependency => {
  expect(() => accept([{ source: runtime, bytes: image(ARM64, [load(dependency)]) }])).toThrow("WorkflowRuntimeNativeDependencyUnsupported");
});
it("accepts recorded system load and interpreter commands but rejects embedded DYLD environment", () => {
  expect(() => accept([{ source: runtime, bytes: image(ARM64, [load("/System/Library/Frameworks/Foundation.framework/Foundation"), load("/usr/lib/dyld", 0xe)]) }])).not.toThrow();
  const environment = Buffer.alloc(8);environment.writeUInt32LE(0x27, 0);environment.writeUInt32LE(8, 4);
  expect(() => accept([{ source: runtime, bytes: image(ARM64, [environment]) }])).toThrow("WorkflowRuntimeNativeEnvironmentUnsupported");
});
it("does not confer runtime eligibility from another architecture or unrelated native asset", () => {
  expect(() => accept([{ source: runtime, bytes: image(X64) }])).toThrow("WorkflowRuntimeNativeArchitectureMismatch");
  expect(() => accept([{ source: "/retained/other.node", bytes: image() }])).toThrow("WorkflowRuntimeNativeImageUnavailable");
  expect(() => accept([{ source: runtime, bytes: image() }, { source: "/retained/x64-asset.node", bytes: image(X64, [load("/custom/unselected.dylib")]) }])).not.toThrow();
  host.architecture = "riscv64";expect(() => accept()).toThrow("WorkflowRuntimeNativeArchitectureUnsupported");
});
it.each([false, true])("selects the actual host slice from a bounded synthetic fat image (64-bit offsets=%s)", wide => {
  const bytes = fat([{ architecture: X64, bytes: image(X64, [load("/custom/unselected.dylib")]) }, { architecture: ARM64, bytes: image() }], wide);
  expect(isWorkflowRuntimeNativeImage(bytes)).toBe(true);expect(() => accept([{ source: runtime, bytes }])).not.toThrow();
});
it("rejects inconsistent fat architecture and truncated or escaping slice offsets", () => {
  const mismatch = fat([{ architecture: X64, bytes: image(ARM64) }]);
  expect(() => accept([{ source: runtime, bytes: mismatch }])).toThrow("WorkflowRuntimeNativeImageInvalid");
  const escaped = fat([{ architecture: ARM64, bytes: image() }]);escaped.writeUInt32BE(4, 16);
  expect(() => accept([{ source: runtime, bytes: escaped }])).toThrow("WorkflowRuntimeNativeImageInvalid");
  expect(() => accept([{ source: runtime, bytes: escaped.subarray(0, 7) }])).toThrow("WorkflowRuntimeNativeImageInvalid");
});
it.each(["count", "length", "command-size", "string-offset", "unterminated"] as const)("refuses malformed synthetic load table %s", corruption => {
  const bytes = image();
  if (corruption === "count") bytes.writeUInt32LE(65537, 16);
  if (corruption === "length") bytes.writeUInt32LE(bytes.length, 20);
  if (corruption === "command-size") bytes.writeUInt32LE(7, 36);
  if (corruption === "string-offset") bytes.writeUInt32LE(bytes.length, 40);
  if (corruption === "unterminated") bytes.fill(0x61, 56);
  expect(() => accept([{ source: runtime, bytes }])).toThrow("WorkflowRuntimeNativeImageInvalid");
});
it("classifies WASM/nonimages as data and cannot mistake data for the retained Node runtime", () => {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);expect(isWorkflowRuntimeNativeImage(wasm)).toBe(false);expect(isWorkflowRuntimeNativeImage(Buffer.alloc(3))).toBe(false);
  expect(() => accept([{ source: runtime, bytes: wasm }])).toThrow("WorkflowRuntimeNativeArchitectureMismatch");
});
