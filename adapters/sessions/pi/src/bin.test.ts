import { describe, expect, it } from "vitest";
import { resolvePiBin } from "./bin.js";

describe("Pi Binary Resolution", () => {
  it("resolves binary path or fallback", () => {
    const bin = resolvePiBin();
    expect(bin).toBeTruthy();
    expect(typeof bin).toBe("string");
  });

  it("respects PI_BIN environment override", () => {
    const orig = process.env.PI_BIN;
    try {
      process.env.PI_BIN = "/bin/sh";
      expect(resolvePiBin()).toBe("/bin/sh");
    } finally {
      if (orig !== undefined) process.env.PI_BIN = orig;
      else delete process.env.PI_BIN;
    }
  });
});
