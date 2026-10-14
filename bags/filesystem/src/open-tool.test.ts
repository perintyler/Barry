import { describe, it, expect } from "vitest";
import { getAppForPath, openAppOverrides } from "./tools.js";

/**
 * BAG-23: the open tool used to bake in one person's installed apps (Sublime
 * Text for .md, IINA, VS Code), so an `open -a` call failed on a machine that
 * lacked them. The category→app map is now read from config
 * (`BARRY_OPEN_APPS`), with the historical choice as the default and the system
 * default (null) for anything unmatched.
 */
describe("open tool app map from config (BAG-23)", () => {
  it("falls back to the built-in defaults when nothing is configured", () => {
    const none = {};
    expect(getAppForPath("notes.md", none)).toBe("Sublime Text");
    expect(getAppForPath("doc.pdf", none)).toBe("Preview");
    expect(getAppForPath("https://example.com", none)).toBe("Google Chrome");
    expect(getAppForPath("clip.mp4", none)).toBe("IINA");
    expect(getAppForPath("main.ts", none)).toBe("Visual Studio Code");
  });

  it("returns null (system default) for an unmatched path", () => {
    expect(getAppForPath("archive.unknownext", {})).toBeNull();
  });

  it("uses a configured override instead of the default", () => {
    const overrides = { markdown: "Typora", url: "Safari" };
    expect(getAppForPath("notes.md", overrides)).toBe("Typora");
    expect(getAppForPath("https://example.com", overrides)).toBe("Safari");
    // A category with no override keeps the default.
    expect(getAppForPath("doc.pdf", overrides)).toBe("Preview");
  });

  it("parses BARRY_OPEN_APPS, ignoring non-string and malformed values", () => {
    expect(openAppOverrides('{"markdown":"Typora","pdf":123,"url":""}')).toEqual({ markdown: "Typora" });
    expect(openAppOverrides("not json")).toEqual({});
    expect(openAppOverrides("[1,2,3]")).toEqual({});
    expect(openAppOverrides(undefined)).toEqual({});
  });
});
