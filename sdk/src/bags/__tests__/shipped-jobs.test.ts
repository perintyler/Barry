/**
 * Every job this repo's bags ship must point at code that exists, and every
 * schedule that fires a job must name one its bag declares.
 *
 * A job whose `main` was renamed fails at its first run — for a schedule,
 * minutes later and unattended — so the break is caught here instead.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../manifest.js";
import { findJob, listAllJobs } from "../../jobs/catalog.js";

const BAGS_DIR = new URL("../../../../bags", import.meta.url).pathname;

const bags = readdirSync(BAGS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(BAGS_DIR, entry.name, "bag.yaml")))
  .map((entry) => ({ dir: join(BAGS_DIR, entry.name), manifest: parseManifest(join(BAGS_DIR, entry.name))! }))
  .filter((bag) => bag.manifest);

const catalog = bags.map((bag) => ({
  name: bag.manifest.name,
  jobs: Object.entries(bag.manifest.jobs ?? {}).map(([name, job]) => ({ ...job, name, dir: bag.dir })),
}));

describe("shipped jobs", () => {
  it("include the sessions bag's background work", () => {
    expect(listAllJobs(catalog).filter((j) => j.bag === "sessions").map((j) => j.name))
      .toEqual(expect.arrayContaining(["watch-session", "bookkeeping", "summarize-sessions", "disk-retention", "reaper", "app-watchdog"]));
  });

  it.each(listAllJobs(catalog).map((job) => [job.qualifiedName, job] as const))("%s runs code that exists", (_name, job) => {
    if (job.runs.using === "node") expect(existsSync(join(job.dir, job.runs.main))).toBe(true);
  });

  it("fire only jobs their bag declares, as node jobs with Barry's Node", () => {
    for (const bag of bags) {
      for (const [name, schedule] of Object.entries(bag.manifest.schedules)) {
        if (schedule.payload.kind !== "job") continue;
        const job = findJob(catalog, schedule.payload.ref, { fromBag: bag.manifest.name });
        expect(job, `${bag.manifest.name}/${name}`).not.toBeNull();
      }
    }
  });

  it("move every sessions schedule, the summarizer included, onto a job", () => {
    const sessions = bags.find((bag) => bag.manifest.name === "sessions")!;
    expect(Object.values(sessions.manifest.schedules).map((s) => s.payload.kind)).toEqual(["job", "job", "job", "job", "job", "job"]);
    // The app watchdog needs no Barry credential; the rest call the API.
    expect(Object.fromEntries(Object.entries(sessions.manifest.jobs ?? {}).map(([name, job]) => [name, job.runs.using === "action" ? [] : job.runs.secrets ?? []])))
      .toMatchObject({ "app-watchdog": [], reaper: ["BARRY_SECRET"], bookkeeping: ["BARRY_SECRET"] });
  });
});

describe("remotable shipped jobs", () => {
  it("offers the sessions bag's summarize-session job to workers with a local model", async () => {
    const { installedJobs } = await import("../../workflows/job-registry.js");
    const bounds = Object.assign({}, ...bags.map((bag) => bag.manifest.bounds ?? {})) as Record<string, { bound: import("../../bounds/types.js").Bound }>;
    const { jobs, skipped } = await installedJobs(catalog, async (name) => bounds[name]?.bound);
    const summarize = jobs.find((job) => job.type === "sessions:summarize-session@1");
    expect(summarize, JSON.stringify(skipped)).toBeDefined();
    expect(summarize!.requires.labels).toEqual({ model: "local" });
    expect(summarize!.flags).toEqual(["--permission", "--allow-net"]);
  });
});
