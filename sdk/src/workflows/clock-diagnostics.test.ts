import { expect, it } from "vitest";
import { ClockDiagnostics } from "./clock-diagnostics.js";

it("reports forward/backward wall jumps independently of monotonic elapsed time", () => {
  const clock = new ClockDiagnostics();
  clock.sample(10_000, 0); clock.sample(10_250, 250);
  expect(clock.status().jumps).toBe(0);
  clock.sample(71_000, 1000);
  expect(clock.status()).toMatchObject({ jumps: 1, lastDriftMs: 60_000 });
  clock.sample(12_000, 2000);
  expect(clock.status()).toMatchObject({ jumps: 2, lastDriftMs: -60_000, maximumDriftMs: 60_000 });
  clock.sample(13_000, 3000);
  expect(clock.status().jumps).toBe(2);
});
