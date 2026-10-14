import { describe, expect, it } from "vitest";
import { testAdapter } from "../adapters/harnesses/index.js";
import { declareSession } from "./index.js";

const mode = testAdapter().modes.guest!;

describe("declareSession", () => {
  it("records the mode's guarantees as a copy, verified when the build matches", () => {
    const declared = declareSession(mode, mode.verifiedOn);
    expect(declared).toEqual({ guarantees: mode.guarantees, harnessVersion: "0.0.0-test", guaranteesUnverified: false });
    expect(declared.guarantees).not.toBe(mode.guarantees);
  });

  it("marks the guarantees unverified on a build they were not shown on", () => {
    expect(declareSession(mode, "0.0.1").guaranteesUnverified).toBe(true);
  });

  it("does not treat an unknown build as a mismatch", () => {
    expect(declareSession(mode)).toEqual({ guarantees: mode.guarantees, guaranteesUnverified: false });
  });
});
