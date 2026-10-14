import { describe, expect, it } from "vitest";
import { assertLaunchd, assertPlatform, hasLaunchd } from "./platform.js";
import { isCliError } from "./cli-error.js";

const GUARD = "this command needs launchd (macOS); on this host run barry setup --link . --no-start and see docs/support.md";

describe("assertPlatform", () => {
  it("passes on darwin-arm64", () => {
    expect(() => assertPlatform("darwin", "arm64")).not.toThrow();
  });
  it.each([
    ["linux", "x64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
  ])("refuses %s-%s", (platform, arch) => {
    expect(() => assertPlatform(platform, arch)).toThrow("releases require darwin-arm64");
  });
});

describe("assertLaunchd", () => {
  // "launchd absent" is /bin/launchctl not existing, matching launchd.ts.
  const present = (path: string) => path === "/bin/launchctl";
  const absent = () => false;

  it("passes on macOS when /bin/launchctl exists", () => {
    expect(() => assertLaunchd("darwin", present)).not.toThrow();
    expect(hasLaunchd("darwin", present)).toBe(true);
  });

  it("throws the exact one-sentence guard when launchd is absent (Linux)", () => {
    expect(() => assertLaunchd("linux", absent)).toThrow(GUARD);
  });

  it("throws when /bin/launchctl is missing even on darwin", () => {
    expect(() => assertLaunchd("darwin", absent)).toThrow(GUARD);
  });

  it("throws a CliError (so main.ts sets the exit code) with the exact message", () => {
    try {
      assertLaunchd("linux", absent);
      throw new Error("expected a throw");
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      expect((error as Error).message).toBe(GUARD);
    }
  });
});
