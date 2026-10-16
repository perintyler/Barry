/** Eligibility for the currently supported sealed Darwin native mapping.
 * This is a dependency contract, not a sandbox for hostile native code. */
import { execFileSync } from "node:child_process";
import { arch, platform, release } from "node:os";

export function workflowRuntimeNativeIdentity(): string {
  if (platform() !== "darwin") throw new Error("WorkflowRuntimeNativePlatformUnsupported");
  const environment = { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" };
  const mounts = execFileSync("/sbin/mount", [], { env: environment, encoding: "utf8", timeout: 1000, maxBuffer: 1_048_576 });
  const root = mounts.split("\n").find(line => line.includes(" on / ("));
  const flags = root?.slice(root.indexOf(" on / (") + 7).replace(/\)\s*$/, "").split(",").map(value => value.trim());
  if (!flags?.includes("sealed") || !flags.includes("read-only")) throw new Error("WorkflowRuntimeSystemMappingUnsupported");
  const build = execFileSync("/usr/bin/sw_vers", ["-buildVersion"], { env: environment, encoding: "utf8", timeout: 1000, maxBuffer: 4096 }).trim();
  if (!/^[A-Za-z0-9.]+$/.test(build)) throw new Error("WorkflowRuntimeSystemMappingUnsupported");
  return JSON.stringify({ platform: platform(), arch: arch(), kernel: release(), sealedSystemBuild: build });
}

interface NativeSlice { architecture: number; dependencies: string[] }
/** Parse the actual load commands, not an otool string-prefix guess. */
function slices(bytes: Buffer): NativeSlice[] {
  if (bytes.length < 4) return [];
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    if (bytes.length < 8) throw new Error("WorkflowRuntimeNativeImageInvalid");
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
    if (!count || count > 64 || 8 + count * stride > bytes.length) throw new Error("WorkflowRuntimeNativeImageInvalid");
    const result: NativeSlice[] = [];
    for (let index = 0; index < count; index++) {
      const at = 8 + index * stride;
      const offset = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
      const size = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 32 || offset < 8 + count * stride || offset + size > bytes.length) throw new Error("WorkflowRuntimeNativeImageInvalid");
      const value = slices(bytes.subarray(offset, offset + size));
      if (value.length !== 1 || value[0].architecture !== bytes.readUInt32BE(at)) throw new Error("WorkflowRuntimeNativeImageInvalid");
      result.push(...value);
    }
    return result;
  }
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) return [];
  if (bytes.length < 32) throw new Error("WorkflowRuntimeNativeImageInvalid");
  const count = bytes.readUInt32LE(16), length = bytes.readUInt32LE(20), dependencies: string[] = [];
  if (count > 65536 || length > bytes.length - 32) throw new Error("WorkflowRuntimeNativeImageInvalid");
  const end = 32 + length;
  let offset = 32;
  const loads = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023, 0xe]);
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error("WorkflowRuntimeNativeImageInvalid");
    const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 4 || offset + size > end) throw new Error("WorkflowRuntimeNativeImageInvalid");
    if (command === 0x27) throw new Error("WorkflowRuntimeNativeEnvironmentUnsupported");
    if (loads.has(command)) {
      if (size < 12) throw new Error("WorkflowRuntimeNativeImageInvalid");
      const name = bytes.readUInt32LE(offset + 8), terminator = bytes.indexOf(0, offset + name);
      if (name < 12 || name >= size || terminator < 0 || terminator >= offset + size) throw new Error("WorkflowRuntimeNativeImageInvalid");
      dependencies.push(bytes.subarray(offset + name, terminator).toString("utf8"));
    }
    offset += size;
  }
  if (offset !== end) throw new Error("WorkflowRuntimeNativeImageInvalid");
  return [{ architecture: bytes.readUInt32LE(4), dependencies }];
}

export function isWorkflowRuntimeNativeImage(bytes: Buffer): boolean {
  return bytes.length >= 4 && ([0xcafebabe, 0xcafebabf].includes(bytes.readUInt32BE(0)) || bytes.readUInt32LE(0) === 0xfeedfacf);
}
export function assertWorkflowRuntimeNativeFiles(files: { source: string; bytes: Buffer }[], runtime: string, acceptedSystem: string): void {
  if (workflowRuntimeNativeIdentity() !== acceptedSystem) throw new Error("WorkflowRuntimeSystemMappingChanged");
  const architecture = arch() === "arm64" ? 0x0100000c : arch() === "x64" ? 0x01000007 : undefined;
  if (!architecture) throw new Error("WorkflowRuntimeNativeArchitectureUnsupported");
  let matchedRuntime = false;
  for (const file of files) {
    const images = slices(file.bytes), selected = images.filter(image => image.architecture === architecture);
    // Other architecture assets are retained as data; they confer no eligibility.
    // The selected Node executable itself must contain the actual host slice.
    if (file.source === runtime) { if (!selected.length) throw new Error("WorkflowRuntimeNativeArchitectureMismatch");matchedRuntime = true; }
    for (const image of selected) for (const dependency of image.dependencies) {
      // This profile permits only the recorded sealed OS/dyld-cache mapping.
      // Relative/rpath and nonsealed custom dylibs need a different explicitly
      // qualified native mapping; copying them does not rewrite their load paths.
      if (!/^\/(?:usr\/lib\/|System\/Library\/)/.test(dependency) || dependency.split("/").some(part => part === ".." || part === ".")) throw new Error("WorkflowRuntimeNativeDependencyUnsupported: " + dependency);
    }
  }
  if (!matchedRuntime) throw new Error("WorkflowRuntimeNativeImageUnavailable");
}
