import { expect, it, vi } from "vitest";
import { testAdapter, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { scheduleRuntime } from "./schedule-runtime.js";
const adapter = testAdapter();
const mode = { ...adapter.modes.guest!, verifiedOn: "0.160.1" };
const record: InstalledAdapter = { ...adapter, packageName: "fixture", contractVersion: 1, path: "/fixture", version: "1.0.0", installedAt: new Date().toISOString(), modes: { hosted: mode, guest: null, instrumented: null } };
it("shows local untested-version warnings without executing a scheduled action", () => {
  const result = scheduleRuntime(record.id, [record], { platform: "darwin", which: () => "/local/harness", run: () => ({ stdout: "0.162.0", code: 0 }) });
  expect(result).toMatchObject({ scope: "local", checks: expect.arrayContaining([expect.objectContaining({ name: "compatibility", status: "warning" })]) });
});
it("assesses bundled hosted builds without probing an unrelated CLI", () => {
  const run = vi.fn();
  const result = scheduleRuntime(record.id, [{ ...record, modes: { ...record.modes, hosted: { ...mode, build: "bundled" } } }], { platform: "darwin", which: () => null, run });
  expect(result).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: "compatibility", status: "ok" })]) });
  expect(run).not.toHaveBeenCalled();
});
