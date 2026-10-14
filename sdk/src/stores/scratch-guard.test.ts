import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertScratchStoreUnderTest } from "./scratch-guard.js";

/** Where an installed instance keeps its sessions store, below a user's home. */
const INSTALLED_SESSIONS_DB = "Library/Application Support/Barry/data/sessions/sessions.db";

/** Exercise the live Vitest opening guard against owner stores and valid scratch paths. */
describe("assertScratchStoreUnderTest", () => {
  it("refuses a real store path", () => {
    expect(() =>
      assertScratchStoreUnderTest("sessions", join(process.env.HOME ?? "/Users/nobody", INSTALLED_SESSIONS_DB)),
    ).toThrow(/Refusing to open the sessions store/);
  });

  it("allows a path under the OS temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-guard-"));
    expect(() => assertScratchStoreUnderTest("sessions", join(dir, "sessions.db"))).not.toThrow();
  });

  it("allows :memory:", () => {
    expect(() => assertScratchStoreUnderTest("events", ":memory:")).not.toThrow();
  });

  /**
   * The docblock's own stated limit, pinned so it cannot quietly widen: the
   * rule is "under the temp directory", NOT "the path contains 'test'". A
   * developer whose home is /Users/testarossa would otherwise have every
   * production store waved through.
   */
  it("is not substring matching on 'test'", () => {
    expect(() => assertScratchStoreUnderTest("sessions", join("/Users/testarossa", INSTALLED_SESSIONS_DB))).toThrow();
    expect(() => assertScratchStoreUnderTest("sessions", "/Users/me/repos/latest-barry/sessions.db")).toThrow();
  });

  /**
   * The trailing-separator case the implementation calls out by name: a
   * sibling directory whose name merely STARTS with the temp path is not
   * inside it.
   */
  it("does not accept a sibling that shares the temp prefix", () => {
    expect(() => assertScratchStoreUnderTest("sessions", `${tmpdir()}-not-really/sessions.db`)).toThrow();
  });

  it("honours the documented opt-out", () => {
    const prev = process.env.BARRY_ALLOW_NON_TEST_STORE;
    process.env.BARRY_ALLOW_NON_TEST_STORE = "1";
    try {
      expect(() => assertScratchStoreUnderTest("sessions", join("/Users/nobody", INSTALLED_SESSIONS_DB))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.BARRY_ALLOW_NON_TEST_STORE;
      else process.env.BARRY_ALLOW_NON_TEST_STORE = prev;
    }
  });
});
