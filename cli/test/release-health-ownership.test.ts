import { mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { SystemCleanupLease } from "../src/releases/health-ownership.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "release-health-ownership-")); roots.push(root); return join(root, "system-state"); }
it("a refused collision preserves existing data even when finally requests destructive cleanup", () => {
  const path = fixture(); writeFileSync(path, "preexisting unrelated data");
  const lease = new SystemCleanupLease([path]);
  expect(() => lease.start(() => { throw new Error("privileged setup must not execute"); })).toThrow("already exist");
  lease.cleanup(() => rmSync(path));
  expect(readFileSync(path, "utf8")).toBe("preexisting unrelated data");
  expect(lease.started).toBe(false);
});
it("partial privileged setup failure retains cleanup ownership for exactly the claimed paths", () => {
  const path = fixture(), unrelated = `${path}-unrelated`; writeFileSync(unrelated, "retained");
  const lease = new SystemCleanupLease([path]);
  expect(() => lease.start(() => { writeFileSync(path, "partially installed"); throw new Error("setup interrupted"); })).toThrow("setup interrupted");
  lease.cleanup(() => { for (const owned of lease.paths) rmSync(owned); });
  expect(() => readFileSync(path)).toThrow(); expect(readFileSync(unrelated, "utf8")).toBe("retained");
  expect(lease.started).toBe(true);
});
it("preserves a preexisting dangling symlink when refusing privileged setup", () => {
  const path = fixture(), missing = `${path}-missing`; symlinkSync(missing, path);
  const lease = new SystemCleanupLease([path]);
  expect(() => lease.start(() => { throw new Error("must not run"); })).toThrow("already exist");
  lease.cleanup(() => rmSync(path)); expect(readlinkSync(path)).toBe(missing);
});
