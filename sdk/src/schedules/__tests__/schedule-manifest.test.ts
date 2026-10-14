import { describe, it, expect } from "vitest";
import { parseManifestObject } from "../../bags/manifest.js";

const BAG_DIR = "/bags/ops";

function parse(schedules: Record<string, unknown>) {
  return parseManifestObject({ name: "ops", description: "d", schedules }, "test", BAG_DIR).schedules;
}

const script = { description: "Reap", run: { command: "tsx", args: ["src/reaper.ts"] } };

describe("schedules:", () => {
  it("retains an inline entry action for the shared runtime resolver", () => {
    const schedule = parse({ maintenance: { cron: "0 * * * *", timezone: "UTC", action: { description: "Maintain", run: { entry: "scripts/maintain.mjs", args: [""] } } } }).maintenance;
    expect(schedule.payload.kind).toBe("inline");
    if (schedule.payload.kind === "inline") {
      expect(schedule.payload.manifest.run).toEqual({ entry: "scripts/maintain.mjs", command: "node", args: [""] });
    }
  });
  it("normalizes each trigger", () => {
    const s = parse({
      a: { every: "5m", action: script },
      b: { cron: "30 4 * * *", timezone: "America/New_York", action: script },
      c: { at: "2026-10-01T09:00:00-04:00", action: script },
    });
    expect(s.a.trigger).toEqual({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" });
    expect(s.b.trigger).toEqual({ kind: "cron", expression: "30 4 * * *", timezone: "America/New_York" });
    expect(s.c.trigger).toEqual({ kind: "at", time: "2026-10-01T09:00:00-04:00" });
  });

  it("defaults overlap, catch-up and enabled", () => {
    const s = parse({ a: { every: "1m", action: script } }).a;
    expect([s.overlap, s.catchUp, s.enabled]).toEqual(["skip", "once", true]);
  });

  it("validates an inline action as a full action, named after the schedule", () => {
    const s = parse({ reaper: { every: "1m", action: script } }).reaper;
    expect(s.payload.kind).toBe("inline");
    if (s.payload.kind !== "inline") return;
    expect(s.payload.manifest.name).toBe("reaper");
    expect(s.payload.manifest.run).toEqual({ command: "tsx", args: ["src/reaper.ts"] });
    expect(s.payload.manifest.context).toBe("none");
  });

  it("makes an inline prompt action detached unless it says otherwise", () => {
    const s = parse({ digest: { cron: "0 9 * * 1", action: { description: "d", prompt: "Summarize the week" } } }).digest;
    expect(s.payload.kind === "inline" && s.payload.manifest.context).toBe("none");
  });

  it("keeps a reference as written, for the catalog to resolve at fire time", () => {
    const s = parse({ digest: { cron: "0 9 * * 1", action: "slack:weekly-digest", inputs: { channel: "eng" }, identity: "bux" } }).digest;
    expect(s.payload).toEqual({ kind: "ref", ref: "slack:weekly-digest" });
    expect(s.inputs).toEqual({ channel: "eng" });
    expect(s.identity).toBe("bux");
  });

  // Each of these parsed under `jobs:` and then never ran. They must fail the manifest.
  it.each([
    ["no trigger", { action: script }, /needs a trigger/],
    ["two triggers", { every: "1m", cron: "* * * * *", action: script }, /exactly one trigger/],
    ["an invalid cron field", { cron: "61 * * * *", action: script }, /minute/],
    ["an unknown timezone", { cron: "0 9 * * *", timezone: "Mars/Base", action: script }, /timezone/i],
    ["a timezone on a one-off", { at: "2030-01-01T00:00:00Z", timezone: "UTC", action: script }, /only applies to recurring/],
    ["an unparseable at", { at: "next tuesday", action: script }, /not an ISO-8601/],
    ["an elapsed interval", { every: "61s", action: script }, /Invalid option/],
    ["an inline action with prompt and run", { every: "1m", action: { ...script, prompt: "p" } }, /only one of `prompt`, `run` or `job`/],
    ["an inline action escaping its bag", { every: "1m", action: { description: "d", run: "../x.sh" } }, /relative to the action dir/],
  ])("rejects %s", (_label, schedule, message) => {
    expect(() => parse({ bad: schedule })).toThrow(message);
  });

  it("rejects a schedule name that cannot be an id", () => {
    expect(() => parse({ "Nightly Backup": { every: "1m", action: script } })).toThrow(/kebab-case/);
  });
});

 it("compiles script shorthand into the same action contract with credentials, literals and timeout", () => {
   const schedule = parse({ maintenance: { cron: "0 * * * *", entry: "scripts/maintain.ts", args: ["literal argument"], secrets: ["API_KEY"], env: ["MODE=fast"], timeout: "5m" } }).maintenance;
   expect(schedule.payload.kind).toBe("inline");
   if (schedule.payload.kind !== "inline" || !schedule.payload.manifest.run) return;
   expect(schedule.payload.manifest.run).toEqual({ entry: "scripts/maintain.ts", command: "node", args: ["literal argument"] });
   expect(schedule.payload.manifest.secrets).toEqual(["API_KEY"]);
   expect(schedule.payload.manifest.env).toEqual([{ name: "MODE", source: "value", value: "fast" }]);
   expect(schedule.payload.manifest.timeout).toBe(300);
   expect(schedule.payload.manifest.context).toBe("none");
 });
 it.each([
   {}, { entry: "task.ts", action: "other" }, { entry: "../escape.ts" },
   { action: "task", secrets: ["API_KEY"] }, { action: "task", env: ["MODE=fast"] },
   { entry: "task.ts", env: ["MODE"] }, { entry: "task.ts", secrets: ["invalid-name"] },
 ])("rejects invalid shorthand payload %j", payload => {
   expect(() => parse({ maintenance: { cron: "0 * * * *", ...payload } })).toThrow();
 });

describe("calendar schedule contract", () => {
  it.each([
    ["1m", "* * * * *"], ["5m", "*/5 * * * *"], ["15m", "*/15 * * * *"],
    ["30m", "*/30 * * * *"], ["1h", "0 * * * *"], ["1d", "0 0 * * *"],
  ])("compiles %s into calendar cron", (every, expression) => {
    expect(parse({ task: { every, action: script } }).task.trigger).toEqual({ kind: "cron", expression, timezone: "UTC" });
  });
  it("keeps the selected timezone for calendar sugar and defaults cron to UTC", () => {
    expect(parse({ task: { every: "1d", timezone: "America/New_York", action: script } }).task.trigger)
      .toEqual({ kind: "cron", expression: "0 0 * * *", timezone: "America/New_York" });
    expect(parse({ task: { cron: "0 9 * * *", action: script } }).task.trigger)
      .toEqual({ kind: "cron", expression: "0 9 * * *", timezone: "UTC" });
  });
  it.each([
    { every: 60 }, { every: "60s" }, { every: "2h" }, { cron: "0 * * * * *" },
    { cron: "@daily" }, { at: "2030-01-01T09:00:00" }, { at: "2030-02-30T09:00:00Z" },
    { every: "1d", timezone: "+01:00" },
  ])("rejects ambiguous or noncalendar trigger %j", trigger => {
    expect(() => parse({ task: { ...trigger, action: script } })).toThrow();
  });
});

describe("a job payload", () => {
  it("names a job, with the schedule's inputs and permissions", () => {
    const s = parse({ reaper: { every: "5m", traits: ["bash"], job: "reaper", inputs: { dry: true } } }).reaper;
    expect(s.payload).toEqual({ kind: "job", ref: "reaper" });
    expect(s.inputs).toEqual({ dry: true });
    expect(s.traits).toEqual(["bash"]);
  });

  it("is the one payload, and leaves the job its own execution requirements", () => {
    expect(() => parse({ x: { every: "5m", job: "reaper", action: script } })).toThrow(/exactly one payload: `entry`, `action` or `job`/);
    expect(() => parse({ x: { every: "5m", job: "reaper", timeout: 30 } })).toThrow(/a job owns its execution requirements/);
  });
});
