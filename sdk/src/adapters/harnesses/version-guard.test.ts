import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineAdapter, testAdapter } from "./index.js";
import { HarnessVersionMismatch, inspectHarnessVersion, requireVerifiedMajor } from "./version-guard.js";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "version-policy-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const adapter = testAdapter({ requirements: { binary: { command: "fake", versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)", install: {}, recommendedVersion: "0.160.1" } } });
const mode = { verifiedOn: "0.160.1" };
function binary(version: string, directory = root) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "fake"); writeFileSync(path, `#!/bin/sh\necho fake ${version}\n`); chmodSync(path, 0o700); return path;
}
function options() { return { env: { PATH: root }, cacheFile: join(root, "cache.json"), onWarning: vi.fn() }; }
it.each(["0.162.0", "1.0.0", "0.159.0", "0.160.0"])("warns and runs an untested %s", version => {
  binary(version); const opts = options();
  expect(() => requireVerifiedMajor(adapter, mode, opts)).not.toThrow();
  expect(opts.onWarning).toHaveBeenCalledWith(expect.stringContaining(version));
});
it("refuses an explicitly incompatible build with its reason even with the former override", () => {
  binary("0.161.0");
  const versions = { recommendedVersion: "0.160.1", testedVersions: ["0.160.1"], supportedVersions: [], incompatibleVersions: [{ range: { min: "0.161.0", max: "0.161.0" }, reason: "hook regression" }] };
  expect(() => requireVerifiedMajor(adapter, { ...mode, versions }, { ...options(), env: { PATH: root, BARRY_HARNESS_VERSION_CHECK: "off" } })).toThrow(HarnessVersionMismatch);
  expect(() => requireVerifiedMajor(adapter, { ...mode, versions }, options())).toThrow("hook regression");
});
it("does not probe the PATH CLI for bundled modes", () => {
  const run = vi.fn(); const opts = options();
  expect(inspectHarnessVersion(adapter, { ...mode, build: "bundled" }, { ...opts, run })).toMatchObject({ status: "supported", tested: true });
  expect(run).not.toHaveBeenCalled();
});
it("reports missing/unreadable versions as unknown without refusing", () => {
  const opts = options(); requireVerifiedMajor(adapter, mode, opts);
  expect(opts.onWarning).toHaveBeenCalledWith(expect.stringContaining("unknown version"));
});
it("caches unchanged binaries and invalidates a replaced binary", () => {
  const path = binary("0.160.1"); const run = vi.fn(() => "fake 0.160.1"); const opts = { ...options(), run };
  requireVerifiedMajor(adapter, mode, opts); requireVerifiedMajor(adapter, mode, opts);
  expect(run).toHaveBeenCalledTimes(1);
  utimesSync(path, new Date(), new Date(Date.now() + 60_000));
  run.mockReturnValue("fake 0.162.0"); requireVerifiedMajor(adapter, mode, opts);
  expect(run).toHaveBeenCalledTimes(2);
});
it("resolves declared paths before PATH and records the actual executable", () => {
  binary("0.162.0"); const path = binary("0.160.1", join(root, "explicit"));
  expect(inspectHarnessVersion({ ...adapter, requirements: { binary: { ...adapter.requirements.binary, paths: [path] } } }, mode, options())).toMatchObject({ binary: path, observedVersion: "0.160.1", tested: true });
});
it("runs a defined adapter on newer versions rather than throwing before plan", async () => {
  binary("0.162.0"); const plan = vi.fn(async () => ({ command: "fake", args: [], env: {}, guarantees: adapter.modes.guest!.guarantees }));
  const defined = defineAdapter({ ...adapter, modes: { ...adapter.modes, guest: { ...adapter.modes.guest!, ...mode, plan } } });
  await defined.modes.guest!.plan({ sessionId: "test", cwd: root, env: { PATH: root }, mcpServers: {} });
  expect(plan).toHaveBeenCalledOnce();
});

it("honors an explicit executable before PATH, and never falls back from an invalid override", async () => {
  const { resolveHarnessCommand } = await import("./version-guard.js");
  binary("0.162.0");
  const selected = binary("0.160.1", join(root, "selected"));
  const requirements = { binary: { ...adapter.requirements.binary, overrideEnv: "BARRY_TEST_HARNESS_BIN" } };
  const env = { PATH: root, BARRY_TEST_HARNESS_BIN: selected };
  expect(resolveHarnessCommand(requirements, env)).toBe(selected);
  expect(inspectHarnessVersion({ ...adapter, requirements }, mode, { ...options(), env })).toMatchObject({ binary: selected, tested: true });
  expect(() => resolveHarnessCommand(requirements, { ...env, BARRY_TEST_HARNESS_BIN: "/missing/executable" })).toThrow("Configured BARRY_TEST_HARNESS_BIN executable is unavailable");
});
