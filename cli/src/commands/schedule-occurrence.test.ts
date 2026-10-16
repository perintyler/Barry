/**
 * `barry schedule run` with a manual occurrence id (P4 preparation): the run
 * is recorded once in the schedules occurrence ledger, and a retry with the
 * same id observes that occurrence instead of running again. The ledger,
 * dispatcher and process probe are real; the schedule catalog, the script
 * runner and the job registry are stubbed at the package boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleEntry } from "@barry-rocks/schedules-bag";

const scripts = vi.hoisted(() => ({ runs: [] as string[], entry: null as ScheduleEntry | null }));

vi.mock("@barry-rocks/schedules-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/schedules-bag")>();
  return {
    ...actual,
    findSchedule: async (id: string) => (scripts.entry && scripts.entry.id === id ? scripts.entry : null),
    resolveScheduleAction: async () => ({ qualifiedName: "ops:deploy", run: { command: "true", args: [] } }),
    scheduleContext: async () => ({ bags: [], bounds: [], bound: null, allowedToolIds: [] }),
    // The job registry is not part of this test: accept the occurrence as its keyed at-schedule directly.
    acceptJobOccurrence: async (entry: ScheduleEntry, occurrence: { idempotencyKey: string; createdAt: Date; slotAt: Date | null; definition: { reference?: string } }) =>
      actual.createAtSchedule({ bag: entry.bag, action: null, job: occurrence.definition.reference ?? null, dueAt: occurrence.createdAt, idempotencyKey: occurrence.idempotencyKey, createdBy: "schedule" }, occurrence.createdAt).schedule,
    awaitAtSchedule: async (id: string) => ({ ...actual.getAtSchedule(id)!, status: "succeeded" }),
  };
});
vi.mock("@barry-rocks/actions-bag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/actions-bag")>()),
  runScriptAction: async (_action: unknown, options: { trigger: string }) => {
    scripts.runs.push(options.trigger);
    return { run: { id: `arn_${scripts.runs.length}`, status: "complete", summary: "deployed", output: null } };
  },
}));
vi.mock("../resource-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resource-target.js")>()),
  assertOwnedSchedule: () => undefined,
  withRunBounds: <T>(operation: () => Promise<T>) => operation(),
  runSecretTarget: () => ({ kind: "installation" }),
  runOwnerMetadata: () => ({}),
}));

const { scheduleRunCommand } = await import("./schedule.js");
const { setDb, closeDb, getDb, getOccurrence, newScheduleOccurrence, recordOccurrence } = await import("@barry-rocks/schedules-bag");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p4-cli-occurrence-"));
  setDb(new Database(join(root, "schedules.db")));
  scripts.runs.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function schedule(payload: ScheduleEntry["schedule"]["payload"]): ScheduleEntry {
  return {
    id: "ops/deploy",
    bag: "ops",
    name: "deploy",
    dir: "/bags/ops",
    schedule: { trigger: { kind: "cron", expression: "0 3 * * *", timezone: "UTC" }, payload, identity: "ops", bags: [], overlap: "skip", catchUp: "once", enabled: true },
  };
}

describe("barry schedule run with a manual occurrence", () => {
  it("runs a script occurrence once, and a retry with the same id does not run it again", async () => {
    scripts.entry = schedule({ kind: "ref", ref: "ops:deploy" });
    await scheduleRunCommand("ops/deploy", { occurrence: "release-42" });
    expect(scripts.runs).toEqual(["cli"]);
    expect(process.exitCode).toBeUndefined();
    await scheduleRunCommand("ops/deploy", { occurrence: "release-42" });
    expect(scripts.runs).toEqual(["cli"]);
    expect(getOccurrence("ops/deploy@manual:release-42")?.dispatch).toMatchObject({ state: "accepted", workId: "arn_1", outcome: "complete" });
    await scheduleRunCommand("ops/deploy", { occurrence: "release-43" });
    expect(scripts.runs).toEqual(["cli", "cli"]);
  });

  it("does not run an occurrence a dead CLI process may have started", async () => {
    scripts.entry = schedule({ kind: "ref", ref: "ops:deploy" });
    const occurrence = newScheduleOccurrence({ entry: scripts.entry, kind: "manual", discriminator: "release-44", policy: { late: false, coalesced_slots: 1, manual_id: "release-44" }, generation: "legacy" });
    recordOccurrence({ occurrence, state: "pending", now: new Date() });
    // A process that cannot be running: its pid is beyond any live process.
    getDb().prepare("UPDATE work_producer_dispatch SET state = 'dispatching', dispatcher_pid = 2147483646, attempts = 1").run();
    await scheduleRunCommand("ops/deploy", { occurrence: "release-44" });
    expect(scripts.runs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(getOccurrence("ops/deploy@manual:release-44")?.dispatch).toMatchObject({ state: "unknown", lastErrorCode: "legacy_outcome_unknown" });
  });

  it("keys a job occurrence by its manual id, so a retry replays the same one-off", async () => {
    scripts.entry = schedule({ kind: "job", ref: "ops:deploy-job@1" });
    await scheduleRunCommand("ops/deploy", { occurrence: "release-45" });
    await scheduleRunCommand("ops/deploy", { occurrence: "release-45" });
    const rows = getDb().prepare("SELECT idempotency_key FROM one_off").all();
    expect(rows).toEqual([{ idempotency_key: "ops/deploy@manual:release-45" }]);
  });

  it("refuses an occurrence id it could not spell as a key", async () => {
    scripts.entry = schedule({ kind: "ref", ref: "ops:deploy" });
    await expect(scheduleRunCommand("ops/deploy", { occurrence: "has spaces" })).rejects.toThrow(/manual occurrence id/);
    expect(scripts.runs).toEqual([]);
  });

  it("leaves the default run unchanged: no occurrence is recorded", async () => {
    scripts.entry = schedule({ kind: "ref", ref: "ops:deploy" });
    await scheduleRunCommand("ops/deploy");
    expect(scripts.runs).toEqual(["cli"]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM work_producer_occurrence").get()).toEqual({ n: 0 });
  });
});
