import { expect, it } from "vitest";
import { parseManifestObject } from "../bags/manifest.js";
import { validateAction } from "../actions/action-manifest.js";
import { ScheduleSchema } from "../schedules/schedule-manifest.js";
it.each([["token"], ["TOKEN=value"], [""], ["TOKEN", "TOKEN"]].map(secrets => ({ secrets })))("rejects invalid credential selections across launch contracts: %j", ({ secrets }) => {
  for (const field of ["services", "scripts"]) {
    expect(() => parseManifestObject({ name: "fixture", description: "Fixture", [field]: { run: { description: "Run", command: "true", secrets } } })).toThrow();
  }
  expect(() => validateAction({ name: "fixture", description: "Fixture", run: { command: "true" }, secrets }, "/fixture", "fixture")).toThrow();
  expect(ScheduleSchema.safeParse({ every: "1h", entry: "run.ts", secrets }).success).toBe(false);
});
it("accepts distinct uppercase binding names in each launch contract", () => {
  const secrets = ["API_KEY", "BARRY_SECRET"];
  for (const field of ["services", "scripts"]) {
    expect(() => parseManifestObject({ name: "fixture", description: "Fixture", [field]: { run: { description: "Run", command: "true", secrets } } })).not.toThrow();
  }
  expect(() => validateAction({ name: "fixture", description: "Fixture", run: { command: "true" }, secrets }, "/fixture", "fixture")).not.toThrow();
  expect(ScheduleSchema.safeParse({ every: "1h", entry: "run.ts", secrets }).success).toBe(true);
});
