import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, setDb } from "./db.js";
import { getState, updateState } from "./store.js";

/**
 * BAG-20: updateState interpolates patch keys into the UPDATE statement. A
 * whitelist rejects any key that is not a real, writable column before it
 * reaches SQL — the one place in this store that builds a column name from
 * caller input.
 */
describe("updateState column whitelist (BAG-20)", () => {
  beforeEach(() => setDb(new Database(":memory:")));
  afterEach(() => closeDb());

  it("writes a known column", () => {
    const state = updateState("ops/nightly", { paused: true, consecutive_failures: 2 });
    expect(state.paused).toBe(true);
    expect(state.consecutive_failures).toBe(2);
  });

  it("rejects an unknown column rather than interpolating it into SQL", () => {
    expect(() =>
      // A key that is not a column: an injection attempt would arrive this way.
      updateState("ops/nightly", { "paused = 1; DROP TABLE schedule_state; --": true } as never),
    ).toThrow(/unknown column/);
  });

  it("rejects a key that names a real column with trailing SQL and leaves no row", () => {
    expect(() => updateState("ops/nightly", { "paused = 0 WHERE 1=1 --": 1 } as never)).toThrow(/unknown column/);
    // The INSERT ... DO NOTHING created the row, but no corrupt UPDATE ran.
    expect(getState("ops/nightly")?.paused).toBe(false);
  });
});
