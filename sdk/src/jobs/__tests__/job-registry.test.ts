import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "../../bags/manifest.js";
import { listAllActions, type ActionMeta } from "../../actions/action-registry.js";
import { checkActionJobLinks, checkJobLinks, findJob, listAllJobs, parseJobRef, type JobRegistryBag } from "../registry.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  cleanup.length = 0;
});

function bag(name: string, jobs: Record<string, unknown>): JobRegistryBag {
  const manifest = parseManifestObject({ name, description: "A bag for testing", jobs }, name);
  return { name, jobs: Object.entries(manifest.jobs ?? {}).map(([jobName, job]) => ({ ...job, name: jobName, dir: `/bags/${name}` })) };
}

const ops = bag("ops", {
  reaper: { version: 2, runs: { using: "node", main: "src/reaper.ts" } },
  triage: { runs: { using: "action", action: "triage" } },
});
const other = bag("other", { reaper: { runs: { using: "process", command: ["ls"] } } });

describe("job references", () => {
  it("parses bag, name and version", () => {
    expect(parseJobRef("ops:reaper@2")).toEqual({ bag: "ops", name: "reaper", version: "2" });
    expect(parseJobRef("reaper")).toEqual({ name: "reaper" });
  });

  it("resolves a bare name only inside the asking bag", () => {
    expect(findJob([ops, other], "reaper")).toBeNull();
    expect(findJob([ops, other], "reaper", { fromBag: "other" })?.qualifiedName).toBe("other:reaper");
    expect(findJob([ops, other], "ops:reaper")?.dir).toBe("/bags/ops");
  });

  it("holds a pinned version to the declared one", () => {
    expect(findJob([ops], "ops:reaper@2")?.version).toBe("2");
    expect(findJob([ops], "ops:reaper@3")).toBeNull();
  });
});

describe("checkJobLinks", () => {
  const action = (name: string, fields: Partial<ActionMeta>): ActionMeta => ({
    source: "bag", name, bag: "ops", qualifiedName: `ops:${name}`, dir: "/", description: "d",
    requires: { tools: [], secrets: [], bins: [] }, instructions: [], steps: [], scripts: [],
    context: "none", legacySkill: false, slashCommand: false, bagAccess: "enabled", shadowed: false,
    prompt: "p", ...fields,
  } as ActionMeta);

  it("accepts a detached prompt action", () => {
    expect(checkJobLinks(listAllJobs([ops]), [action("triage", {})])).toEqual([]);
  });

  it("reports an action that is missing, runs code, or needs a conversation", () => {
    const jobs = listAllJobs([ops]);
    expect(checkJobLinks(jobs, [])).toEqual([{ job: "ops:triage", problem: expect.stringMatching(/does not exist/) }]);
    expect(checkJobLinks(jobs, [action("triage", { context: "session" })])[0]?.problem).toMatch(/context: session/);
    expect(checkJobLinks(jobs, [action("triage", { prompt: undefined, run: { command: "ls", args: [] } })])[0]?.problem).toMatch(/runs code/);
  });
});

describe("checkActionJobLinks", () => {
  const jobAction = (job: string): ActionMeta => ({
    source: "bag", name: `${job}-action`, bag: "ops", qualifiedName: `ops:${job}-action`, dir: "/", description: "d",
    requires: { tools: [], secrets: [], bins: [] }, instructions: [], steps: [], scripts: [],
    context: "none", legacySkill: false, slashCommand: false, bagAccess: "enabled", shadowed: false, job,
  });

  it("accepts a code job and reports a missing job or a loop back to an action", () => {
    const actions = [jobAction("reaper"), jobAction("gone"), jobAction("triage")];
    expect(checkActionJobLinks(actions, [ops])).toEqual([
      { action: "ops:gone-action", problem: expect.stringMatching(/does not exist/) },
      { action: "ops:triage-action", problem: expect.stringMatching(/runs an action itself/) },
    ]);
  });
});

describe("the action catalog", () => {
  it("gives a job: action its job's contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-catalog-"));
    cleanup.push(dir);
    mkdirSync(join(dir, "actions", "reap"), { recursive: true });
    writeFileSync(join(dir, "actions", "reap", "action.yaml"), "name: reap\ndescription: Reap dead sessions now\njob: reaper\n");
    const withContract = bag("ops", { reaper: { timeout: "1m", input_schema: { type: "object" }, runs: { using: "node", main: "src/reaper.ts" } } });
    const [action] = await listAllActions([{ ...withContract, source: { type: "local", path: dir }, skillsDirs: [], actionsDirs: [join(dir, "actions")], instructionsDirs: [] }]);
    expect(action).toMatchObject({ qualifiedName: "ops:reap", job: "reaper", context: "none", timeout: 60, inputSchema: { type: "object" } });
  });

  it("never lists a job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-catalog-"));
    cleanup.push(dir);
    mkdirSync(join(dir, "actions", "real"), { recursive: true });
    writeFileSync(join(dir, "actions", "real", "action.yaml"), "name: real\ndescription: A real action\nprompt: Do it\n");
    const actions = await listAllActions([{
      name: "ops",
      source: { type: "local", path: dir },
      skillsDirs: [],
      actionsDirs: [join(dir, "actions")],
      instructionsDirs: [],
    }]);
    expect(actions.map((a) => a.qualifiedName)).toEqual(["ops:real"]);
    expect(listAllJobs([ops]).map((j) => j.qualifiedName)).toEqual(["ops:reaper", "ops:triage"]);
  });
});
