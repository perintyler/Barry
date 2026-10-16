import { describe, expect, it } from "vitest";
import { PI_HOSTED, PI_REQUIREMENTS, VERIFIED_ON, VERSION_PATTERN } from "./modes.js";

describe("Pi Modes and Requirements", () => {
  it("declares hosted guarantees matching evidence requirements", () => {
    expect(PI_HOSTED.verifiedOn).toBe(VERIFIED_ON);
    expect(PI_HOSTED.guarantees).toEqual({
      capture: "total",
      delivery: "wake",
      steer: true,
      interrupt: true,
      gating: "per-call",
      keepsVendorUi: false,
      identity: "inherent",
    });
    expect(PI_HOSTED.evidence).toBeDefined();
    expect(PI_HOSTED.egressSandbox).toBe(false);
  });

  it("declares binary requirements with recommended SDK version", () => {
    const bin = PI_REQUIREMENTS.binary;
    expect(bin.command).toBe("pi");
    expect(bin.versionArgs).toEqual(["--version"]);
    expect(bin.recommendedVersion).toBe(VERIFIED_ON);
    expect(new RegExp(VERSION_PATTERN).test(`0.99.2`)).toBe(true);
    expect(new RegExp(VERSION_PATTERN).test(`pi version 0.99.2`)).toBe(true);
  });
});
