import { expect, it } from "vitest";
import { assessVersion, compareVersions, validVersionPolicy, type VersionPolicy } from "./versions.js";
const policy: VersionPolicy = {
  recommendedVersion: "0.162.0", testedVersions: ["0.160.1", "0.162.0"],
  supportedVersions: [{ min: "0.160.1", max: "0.162.0" }],
  incompatibleVersions: [{ range: { min: "0.161.0", max: "0.161.0" }, reason: "synthetic hook regression" }],
};
it.each([
  ["0.160.1", "supported", true], ["0.160.2", "supported", false],
  ["0.162.0", "supported", true], ["0.163.0", "untested", false],
  ["0.160.0", "untested", false], ["1.0.0", "untested", false],
  ["0.161.0", "incompatible", false], ["garbage", "unknown", false], [undefined, "unknown", false],
])("assesses %s", (observed, status, tested) => {
  expect(assessVersion(policy, observed)).toMatchObject({ status, tested });
});
it("preserves complete calendar build identity while ordering by release date", () => {
  const calendar = { recommendedVersion: "2026.10.01-14929f9", testedVersions: ["2026.10.01-14929f9"], supportedVersions: [{ min: "2026.10.01", max: "2026.10.15" }] };
  expect(assessVersion(calendar, "2026.10.01-other")).toMatchObject({ status: "supported", tested: false, observedVersion: "2026.10.01-other" });
  expect(assessVersion(calendar, "2026.11.01-a").status).toBe("untested");
});
it.each([["1.0.0-alpha.2", "1.0.0-alpha.10", -1], ["1.0.0-rc.1", "1.0.0", -1], ["2.0.0", "1.99.0", 1], ["1.0.0+x", "1.0.0+y", 0]])("orders %s and %s", (a,b,result) => {
  expect(compareVersions(a,b)).toBe(result);
});
it("rejects malformed policies and impossible calendar dates", () => {
  expect(validVersionPolicy(policy)).toBe(true);
  expect(validVersionPolicy({ ...policy, supportedVersions: [{}] })).toBe(false);
  expect(validVersionPolicy({ ...policy, supportedVersions: [{ min: "2.0.0", max: "1.0.0" }] })).toBe(false);
  expect(compareVersions("2026.02.30", "2026.03.01")).toBeNull();
});

it("preserves opaque bundled build evidence without inventing an ordered range", () => {
  const custom = { recommendedVersion: "fixture SDK 1", testedVersions: ["fixture SDK 1"], supportedVersions: [{ min: "fixture SDK 1", max: "fixture SDK 1" }] };
  expect(validVersionPolicy(custom)).toBe(true);
  expect(assessVersion(custom, "fixture SDK 1")).toMatchObject({ status: "supported", tested: true });
  expect(assessVersion(custom, "fixture SDK 2")).toMatchObject({ status: "unknown", tested: false });
  expect(validVersionPolicy({ ...custom, supportedVersions: [{ min: "fixture SDK 1", max: "fixture SDK 2" }] })).toBe(false);
});
