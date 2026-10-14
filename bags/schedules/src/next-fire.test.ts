import { describe, it, expect } from "vitest";
import { decide, firstFire, nextFireAfter, ON_TIME_GRACE_MS } from "./next-fire.js";

const at = (iso: string) => new Date(iso);

describe("nextFireAfter", () => {
  it("advances to the next calendar slot", () => {
    expect(nextFireAfter({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" }, at("2026-09-24T10:00:00Z"))).toEqual(at("2026-09-24T10:05:00Z"));
  });

  it("reads cron in its timezone, across a DST change", () => {
    const trigger = { kind: "cron" as const, expression: "30 4 * * *", timezone: "America/New_York" };
    // 04:30 EDT is 08:30Z; the day after DST ends, 04:30 EST is 09:30Z.
    expect(nextFireAfter(trigger, at("2026-10-31T12:00:00Z"))).toEqual(at("2026-11-01T09:30:00Z"));
    expect(nextFireAfter(trigger, at("2026-10-30T12:00:00Z"))).toEqual(at("2026-10-31T08:30:00Z"));
  });

  it("gives a one-off at once, then never", () => {
    const trigger = { kind: "at" as const, time: "2026-10-01T09:00:00Z" };
    expect(nextFireAfter(trigger, at("2026-09-30T00:00:00Z"))).toEqual(at("2026-10-01T09:00:00Z"));
    expect(nextFireAfter(trigger, at("2026-10-01T09:00:00Z"))).toBeNull();
  });
});

describe("firstFire", () => {
  it("waits for the next calendar slot rather than firing on install", () => {
    expect(firstFire({ kind: "cron", expression: "* * * * *", timezone: "UTC" }, at("2026-09-24T10:00:00Z"))).toEqual(at("2026-09-24T10:01:00Z"));
  });

  it("keeps a past at, so a reminder created a moment late still fires", () => {
    expect(firstFire({ kind: "at", time: "2026-09-24T09:59:00Z" }, at("2026-09-24T10:00:00Z"))).toEqual(at("2026-09-24T09:59:00Z"));
  });
});

describe("decide", () => {
  const due = at("2026-09-24T10:00:00Z");

  it("waits until due, and forever with no due time", () => {
    expect(decide(due, "once", at("2026-09-24T09:59:59Z"))).toEqual({ kind: "wait" });
    expect(decide(null, "once", due)).toEqual({ kind: "wait" });
  });

  it("fires on time within the grace", () => {
    expect(decide(due, "none", new Date(due.getTime() + ON_TIME_GRACE_MS))).toEqual({ kind: "fire", late: false });
  });

  it("catches up a missed fire once, or records a miss", () => {
    const later = at("2026-09-25T10:00:00Z");
    expect(decide(due, "once", later)).toEqual({ kind: "fire", late: true });
    expect(decide(due, "none", later)).toEqual({ kind: "miss" });
  });
});

describe("calendar semantics", () => {
  it("uses the next wall-clock slot rather than a full elapsed interval", () => {
    expect(firstFire({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" }, at("2026-09-24T10:03:20Z")))
      .toEqual(at("2026-09-24T10:05:00Z"));
  });
  it("uses UTC when a persisted cron lacks a timezone", () => {
    expect(nextFireAfter({ kind: "cron", expression: "0 9 * * *" }, at("2026-09-24T08:00:00Z")))
      .toEqual(at("2026-09-24T09:00:00Z"));
  });
  it("daily midnight follows calendar days across a 23-hour DST day", () => {
    const trigger = { kind: "cron" as const, expression: "0 0 * * *", timezone: "America/New_York" };
    expect(nextFireAfter(trigger, at("2026-03-08T05:00:00Z"))).toEqual(at("2026-03-09T04:00:00Z"));
  });
  it("skips nonexistent local times", () => {
    expect(nextFireAfter({ kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" }, at("2026-03-08T05:00:00Z")))
      .toEqual(at("2026-03-09T06:30:00Z"));
  });
});

it("does not repeat the same wall-clock slot when DST ends", () => {
  expect(nextFireAfter({ kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" }, at("2026-11-01T05:30:00Z")))
    .toEqual(at("2026-11-02T06:30:00Z"));
});
