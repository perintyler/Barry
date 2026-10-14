import { expect, it } from "vitest";
import { parseManifestObject } from "../manifest.js";
const app = { name: "Demo", description: "Demo viewer", platform: "macos", build: "build:app", output: "dist/Demo.app" };
function parse(value: Record<string, unknown>) { return parseManifestObject({ name: "demo", description: "Demo", apps: { viewer: value } }).apps.viewer; }
it("normalizes package builds and platform registration without dropping protocol metadata", () => {
  expect(parse({ ...app, macos: { "bundle-id": "rocks.barry.demo", "url-schemes": ["barry-demo"], "login-item": true }, "protocol-version": 2, capabilities: { replay: true } }))
    .toMatchObject({ name: "Demo", displayName: "Demo", build: "build:app", output: "dist/Demo.app", bundleId: "rocks.barry.demo", urlSchemes: ["barry-demo"], loginItem: true, protocolVersion: 2, capabilities: { replay: true } });
});
it("accepts explicit Xcode builds for iOS and preserves device posture", () => {
  expect(parse({ ...app, platform: "ios", build: { project: "ios/Demo.xcodeproj", scheme: "Demo" }, ios: { device: false, "bundle-id": "rocks.barry.demo" } }))
    .toMatchObject({ build: { project: "ios/Demo.xcodeproj", scheme: "Demo", configuration: "Release" }, device: false, bundleId: "rocks.barry.demo" });
});
it.each([
  { build: { command: "sh", args: ["build.sh"], output: "Demo.app" } },
  { project: "ios", scheme: "Demo" }, { output: "../Demo.app" }, { output: "/Applications/Demo.app" },
  { build: { project: "../Demo.xcodeproj", scheme: "Demo" } }, { build: "sh build.sh" },
  { ios: { device: true } }, { "bundle-id": "legacy" }, { "display-name": "legacy" }, { env: ["SECRET"] },
])("rejects legacy or invalid app declaration %j", fields => {
  expect(() => parse({ ...app, ...fields })).toThrow();
});
