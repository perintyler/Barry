import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { setDb, closeDb, getDb } from "./db.js";
import { writeHeartbeat } from "./store.js";
import { schedulerHealth, HEARTBEAT_STALE_MS } from "./health.js";

beforeEach(() => setDb(new Database(":memory:")));
afterAll(() => closeDb());

describe("schedulerHealth", () => {
  it("reports a scheduler that never started as down, not fine", () => {
    expect(schedulerHealth()).toMatchObject({ status: "down", reason: expect.stringMatching(/never written/) });
  });

  it("is ok with a fresh heartbeat and no load errors", () => {
    writeHeartbeat(3, []);
    expect(schedulerHealth().status).toBe("ok");
  });

  it("goes down when the heartbeat is stale", () => {
    writeHeartbeat(3, []);
    const later = new Date(Date.now() + HEARTBEAT_STALE_MS + 1_000);
    expect(schedulerHealth(later)).toMatchObject({ status: "down", reason: expect.stringMatching(/last heartbeat/) });
  });

  it("is degraded, not ok, while a bag's schedules cannot load", () => {
    writeHeartbeat(3, ["bag ops: invalid manifest"]);
    expect(schedulerHealth()).toMatchObject({ status: "degraded", reason: "bag ops: invalid manifest" });
  });

  it("is down when the store cannot be read", () => {
    getDb().exec("DROP TABLE heartbeat");
    expect(schedulerHealth()).toMatchObject({ status: "down", reason: expect.stringMatching(/cannot read/) });
  });
});
