import { describe, expect, it } from "vitest";
import { testAdapter } from "../adapters/harnesses/index.js";
import { declareSession } from "./index.js";

const mode = testAdapter().modes.guest!;

describe("declareSession", () => {
  it("records the mode's guarantees as a copy, verified when the build matches", () => {
    const declared = declareSession(mode, mode.verifiedOn);
    expect(declared).toMatchObject({ guarantees: mode.guarantees, harnessVersion: "0.0.0-test", guaranteesUnverified: false });
    expect(declared.guarantees).not.toBe(mode.guarantees);
  });

  it("marks the guarantees unverified on a build they were not shown on", () => {
    expect(declareSession(mode, "0.0.1").guaranteesUnverified).toBe(true);
  });

  it("records unknown builds as unverified", () => {
    expect(declareSession(mode)).toMatchObject({ guarantees: mode.guarantees, guaranteesUnverified: true, versionAssessment: { status: "unknown" } });
  });
});

it("retains verification of previously tested versions when the recommendation changes", () => {
  const versions = { recommendedVersion: "2.2.0", testedVersions: ["2.1.0", "2.2.0"], supportedVersions: [{ min: "2.1.0", max: "2.2.0" }] };
  expect(declareSession({ ...mode, versions }, "2.1.0")).toMatchObject({ guaranteesUnverified: false, versionAssessment: { status: "supported", tested: true } });
  expect(declareSession({ ...mode, versions }, "2.1.1")).toMatchObject({ guaranteesUnverified: true, versionAssessment: { status: "supported", tested: false } });
});
