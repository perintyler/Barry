import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadRuntime, nodeRuntime, runtimeTarball, sha256, type NodeRuntime } from "./runtime.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("pins the major the workspace builds native modules against", () => {
  expect(nodeRuntime().version.split(".")[0]).toBe(process.versions.node.split(".")[0]);
});
it("pins nodejs.org's darwin tarball for each architecture", () => {
  for (const arch of ["arm64", "x64"]) {
    const runtime = nodeRuntime(arch);
    expect(runtime.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.url).toBe(`https://nodejs.org/dist/v${runtime.version}/node-v${runtime.version}-darwin-${arch}.tar.gz`);
  }
  expect(() => nodeRuntime("ppc")).toThrow("no pinned Node runtime");
});
it("caches the tarball in the instance's cache", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-runtime-")); roots.push(root); vi.stubEnv("BARRY_HOME", root);
  expect(runtimeTarball()).toBe(join(root, "cache", "runtime", `${nodeRuntime().name}.tar.gz`));
});
it("fetches only when the cached tarball is missing or wrong, and never keeps a mismatched download", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-runtime-")); roots.push(root);
  const bytes = new TextEncoder().encode("tarball");
  const runtime: NodeRuntime = { version: "0.0.0", name: "node-v0.0.0-darwin-test", url: "https://nodejs.org/fixture.tar.gz", sha256: sha256(bytes) };
  const path = join(root, "cache", "fixture.tar.gz");
  const fetchTarball = vi.fn(async () => bytes);
  expect(await downloadRuntime(fetchTarball, runtime, path)).toBe(true);
  expect(fetchTarball).toHaveBeenCalledWith(runtime.url); expect(readFileSync(path, "utf8")).toBe("tarball");
  expect(await downloadRuntime(fetchTarball, runtime, path)).toBe(false); expect(fetchTarball).toHaveBeenCalledTimes(1);
  writeFileSync(path, "truncated");
  expect(await downloadRuntime(fetchTarball, runtime, path)).toBe(true); expect(fetchTarball).toHaveBeenCalledTimes(2);
  rmSync(path);
  await expect(downloadRuntime(async () => new TextEncoder().encode("tampered"), runtime, path)).rejects.toThrow("does not match its pinned SHA-256");
  expect(existsSync(path)).toBe(false);
});

it("prefers the shipped tarball over the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-runtime-")); roots.push(root);
  const runtime = nodeRuntime();
  mkdirSync(join(root, "runtime"));
  const path = join(root, "runtime", `${runtime.name}.tar.gz`);
  writeFileSync(path, "shipped");
  expect(runtimeTarball(runtime, root)).toBe(path);
});
it("refuses a mismatched shipped tarball without fetching or writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-runtime-")); roots.push(root);
  const runtime = nodeRuntime();
  mkdirSync(join(root, "runtime"));
  const path = join(root, "runtime", `${runtime.name}.tar.gz`);
  writeFileSync(path, "tampered");
  const fetchTarball = vi.fn(async () => new Uint8Array());
  await expect(downloadRuntime(fetchTarball, runtime, path, root)).rejects.toThrow("reinstall this release");
  expect(fetchTarball).not.toHaveBeenCalled();
  expect(readFileSync(path, "utf8")).toBe("tampered");
});
it("uses a supplied export's runtime pin", () => {
  const pin = { version: "26.0.0", sha256: { arm64: "a".repeat(64), x64: "b".repeat(64) } };
  expect(nodeRuntime("arm64", pin)).toEqual({ version: pin.version, name: "node-v26.0.0-darwin-arm64", sha256: pin.sha256.arm64, url: "https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz" });
});
