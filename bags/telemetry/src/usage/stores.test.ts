import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// os.homedir() is read through a namespace import in stores.ts; an ESM
// namespace cannot be spied, so the value is controlled with a module mock.
let homeValue = "/home/someone";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeValue };
});

import { repoOf, userHome } from "./stores.js";

/**
 * BAG-11: the usage read model derived HOME from `process.env.HOME` with a
 * hard-coded `/Users/tyler` fallback — a stranger's path on anyone else's
 * machine. It now comes from `os.homedir()` and fails loudly when that is empty.
 */
describe("userHome (BAG-11)", () => {
  beforeEach(() => {
    homeValue = "/home/someone";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("comes from os.homedir(), not process.env.HOME", () => {
    vi.stubEnv("HOME", "/Users/tyler"); // the old hard-coded fallback value
    expect(userHome()).toBe("/home/someone");
  });

  it("strips a trailing slash", () => {
    homeValue = "/home/someone/";
    expect(userHome()).toBe("/home/someone");
  });

  it("fails loudly when homedir is empty rather than guessing", () => {
    homeValue = "";
    expect(() => userHome()).toThrow(/homedir/);
  });

  it("repoOf normalizes a worktree under the real home to its first two segments", () => {
    expect(repoOf("/home/someone/repos/barry/worktree")).toBe("repos/barry");
    // Outside home: not stripped, so grouped by its own first two segments.
    expect(repoOf("/elsewhere/project")).toBe("/elsewhere");
    expect(repoOf("")).toBeNull();
    expect(repoOf(42)).toBeNull();
  });
});
