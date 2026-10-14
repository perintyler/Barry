import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { barryAppSupportDir, barryCurrentDir, barryReleasesDir, installationRoot } from "@barry-rocks/sdk/services";
import { runningNodePath } from "@barry-rocks/sdk/internal/services";
import { copyRelease, currentInstallation, linkCheckout, linkedNode, pointCurrent, pruneReleases } from "./current.js";
import { readRelease, type Release } from "./release.js";
import { receiptId, writeReceipt } from "./receipts.js";
let home: string;
let root: string;
const release: Release = { version: "0.0.0-test", commit: "1".repeat(40), platform: "darwin-arm64", node: { version: "26.5.0", sha256: "2".repeat(64) }, stores: {}, built: "2026-10-08T00:00:00.000Z" };
function checkout(): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "identity.yaml"), "name: Barry");
  writeFileSync(join(root, "bin/barry"), "#!/bin/sh\n", { mode: 0o755 });
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "barry-current-"));
  root = join(home, "checkout");
  vi.stubEnv("HOME", home);
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_NODE", process.execPath);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it("replaces a link atomically and refuses a real directory", () => {
  checkout();
  pointCurrent(root);
  expect(readlinkSync(barryCurrentDir())).toBe(root);
  const next = join(home, "next");
  mkdirSync(next);
  pointCurrent(next);
  expect(readlinkSync(barryCurrentDir())).toBe(next);
  rmSync(barryCurrentDir());
  mkdirSync(barryCurrentDir());
  expect(() => pointCurrent(root)).toThrow("not a symbolic link");
  expect(() => currentInstallation()).toThrow("not a symbolic link");
});
it("copies executable files and relative links, reuses a commit and refuses another", () => {
  checkout();
  mkdirSync(join(root, "runtime/bin"), { recursive: true });
  writeFileSync(join(root, "runtime/bin/node"), "node", { mode: 0o755 });
  writeFileSync(join(root, "release.json"), JSON.stringify(release));
  symlinkSync("barry", join(root, "bin/alias"));
  const copied = copyRelease(root, release);
  expect(copied).toBe(join(barryReleasesDir(), release.version));
  expect(readRelease(copied)).toEqual(release);
  for (const file of ["bin/barry", "runtime/bin/node"]) expect(statSync(join(copied, file)).mode & 0o777).toBe(0o755);
  expect(readlinkSync(join(copied, "bin/alias"))).toBe("barry");
  expect(copyRelease(root, release)).toBe(copied);
  expect(() => copyRelease(root, { ...release, commit: "3".repeat(40) })).toThrow("another commit");
  pointCurrent(realpathSync(copied));
  expect(readlinkSync(barryCurrentDir())).toBe(`releases/${release.version}`);
});
it("refuses invalid checkouts and release-owned Node binaries", () => {
  expect(() => linkCheckout(root)).toThrow("does not exist");
  mkdirSync(root);
  expect(() => linkCheckout(root)).toThrow("identity.yaml");
  writeFileSync(join(root, "identity.yaml"), "");
  expect(() => linkCheckout(root)).toThrow("executable bin/barry");
  checkout();
  chmodSync(join(root, "bin/barry"), 0o644);
  expect(() => linkCheckout(root)).toThrow("executable bin/barry");
  chmodSync(join(root, "bin/barry"), 0o755);
  expect(linkCheckout(root)).toEqual({ root: realpathSync(root), node: process.execPath });
  writeFileSync(join(root, "release.json"), JSON.stringify(release));
  expect(() => linkCheckout(root)).toThrow("barry upgrade installs releases");
  rmSync(join(root, "release.json"));
  const node = join(home, "release/runtime/bin/node");
  mkdirSync(join(node, ".."), { recursive: true });
  writeFileSync(node, "node", { mode: 0o755 });
  writeFileSync(join(home, "release/release.json"), JSON.stringify(release));
  vi.stubEnv("BARRY_NODE", node);
  expect(() => linkCheckout(root)).toThrow("set BARRY_NODE");
});
it("relinks from a release current with the Node running setup, not the release's runtime", () => {
  checkout();
  const installed = join(home, "installed");
  mkdirSync(join(installed, "runtime/bin"), { recursive: true });
  writeFileSync(join(installed, "runtime/bin/node"), "node", { mode: 0o755 });
  writeFileSync(join(installed, "release.json"), JSON.stringify(release));
  pointCurrent(installed);
  vi.stubEnv("BARRY_NODE", undefined);
  expect(linkCheckout(root)).toEqual({ root: realpathSync(root), node: runningNodePath() });
});
it("describes a checkout, linked checkout, release and dangling selector", () => {
  expect(currentInstallation()).toEqual(expect.objectContaining({ current: false, kind: "checkout", root: installationRoot() }));
  checkout();
  pointCurrent(root);
  expect(currentInstallation()).toEqual(expect.objectContaining({ current: true, kind: "link", target: root, root: barryCurrentDir() }));
  writeFileSync(join(root, "release.json"), JSON.stringify(release));
  expect(currentInstallation()).toEqual(expect.objectContaining({ kind: "release", version: release.version, commit: release.commit }));
  rmSync(root, { recursive: true });
  expect(existsSync(barryCurrentDir())).toBe(false);
  expect(currentInstallation()).toEqual({ current: true, kind: "missing", target: root, root: barryCurrentDir() });
});
it("finds the linked Node in user definitions when the environment has no executable Node", () => {
  mkdirSync(barryAppSupportDir(), { recursive: true });
  vi.stubEnv("BARRY_NODE", "/missing/node");
  writeFileSync(join(barryAppSupportDir(), "managed-definitions.json"), JSON.stringify([
    { name: "system", command: [process.execPath], domain: "system", environment: { BARRY_NODE: process.execPath } },
    { name: "user", command: [process.execPath], domain: "gui/501", environment: { BARRY_NODE: process.execPath } },
  ]));
  expect(linkedNode()).toBe(process.execPath);
  writeFileSync(join(barryAppSupportDir(), "managed-definitions.json"), "[]");
  expect(linkedNode()).toBeUndefined();
});
it("prunes other releases and staging folders while keeping current and the last receipt's from", () => {
  checkout();
  writeFileSync(join(root, "release.json"), JSON.stringify({ ...release, version: "1.0.0" }));
  const a = copyRelease(root, { ...release, version: "1.0.0" });
  pointCurrent(a);
  const bRelease = { ...release, version: "2.0.0", commit: "3".repeat(40) };
  writeFileSync(join(root, "release.json"), JSON.stringify(bRelease));
  const b = copyRelease(root, bRelease);
  const cRelease = { ...release, version: "3.0.0", commit: "4".repeat(40) };
  writeFileSync(join(root, "release.json"), JSON.stringify(cRelease));
  const c = copyRelease(root, cRelease), staged = join(barryReleasesDir(), ".3.0.0-x");
  mkdirSync(staged);
  pointCurrent(b);
  writeReceipt({ format: 1, id: receiptId(), kind: "upgrade", state: "complete", from: { kind: "release", version: "1.0.0", commit: release.commit }, to: { kind: "release", version: "2.0.0", commit: bRelease.commit }, generations: { before: null, after: null }, snapshot: null, services: [], started: new Date().toISOString() });
  expect(pruneReleases()).toHaveLength(2);
  expect([a, b, join(barryReleasesDir(), "upgrades")].every(existsSync)).toBe(true);
  expect([c, staged].some(existsSync)).toBe(false);
});
