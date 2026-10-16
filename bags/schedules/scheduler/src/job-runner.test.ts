/**
 * Job one-offs, run for real: a Python process job and a TypeScript node job
 * write to stdout and the runner checks it against the job's contract.
 *
 * Only the bag registry is faked (a literal bag with `jobs:`); the schedules
 * and actions stores are in-memory databases, and the processes are real.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestObject } from "@barry-rocks/sdk/bags";
import { setDb as setActionsDb, closeDb as closeActionsDb } from "@barry-rocks/actions-bag";
import { ActionRuns } from "@barry-rocks/actions-bag";
import { setDb, closeDb } from "@barry-rocks/schedules-bag";
import { claimOne, createAtSchedule, type CreateAtScheduleInput } from "@barry-rocks/schedules-bag";

let bags: Array<{ name: string; jobs: unknown[] }> = [];
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: async () => ({ bags }),
}));
let bounds: Record<string, unknown> = {};
vi.mock("@barry-rocks/identities-bag", () => ({
  bounds: {
    get: async (nameOrRef: string | { name: string }) => {
      const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
      return bounds[name] ? { name, ...(bounds[name] as Record<string, unknown>) } : undefined;
    },
  },
}));

const { runJobAtSchedule } = await import("./job-runner.js");

const HERE = dirname(fileURLToPath(import.meta.url));
let home: string;
let bagDir: string;
let fakeBin: string;

beforeEach(() => {
  setDb(new Database(":memory:"));
  setActionsDb(new Database(":memory:"));
  home = mkdtempSync(join(tmpdir(), "job-runner-home-"));
  vi.stubEnv("BARRY_HOME", home);
  bagDir = mkdtempSync(join(tmpdir(), "job-runner-bag-"));
  // tsx resolves from the entry's checkout, as it does for an installed bag.
  symlinkSync(resolve(HERE, "../../node_modules"), join(bagDir, "node_modules"));
  writeFileSync(join(bagDir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(bagDir, "jobs"));
  mkdirSync(join(bagDir, "src"));
  writeFileSync(join(bagDir, "jobs", "echo.py"), [
    "import json, os, sys",
    "inputs = json.load(sys.stdin)",
    "print(json.dumps({'greeting': 'hello ' + inputs['name'], 'key': os.environ['BARRY_JOB_KEY'], 'attempt': os.environ['BARRY_JOB_ATTEMPT']}))",
  ].join("\n"));
  writeFileSync(join(bagDir, "src", "echo.ts"), [
    "const chunks: string[] = [];",
    "for await (const chunk of process.stdin) chunks.push(String(chunk));",
    "const inputs: { name: string } = JSON.parse(chunks.join(\"\"));",
    "process.stdout.write(JSON.stringify({ greeting: `hello ${inputs.name}`, node: process.execPath }));",
  ].join("\n"));
  writeFileSync(join(bagDir, "src", "peek.mjs"), [
    "import { readFileSync } from \"node:fs\";",
    "const results = {};",
    "for (const path of JSON.parse(readFileSync(0, \"utf8\")).paths) {",
    "  try { readFileSync(path); results[path] = \"read\"; } catch (error) { results[path] = error.code; }",
    "}",
    "try { (await import(\"node:child_process\")).execFileSync(\"true\"); results.child = \"spawned\"; } catch (error) { results.child = error.code; }",
    "process.stdout.write(JSON.stringify(results));",
  ].join("\n"));
  writeFileSync(join(bagDir, "src", "ps.ts"), "console.log(\"  PID TTY  TIME CMD\\n  1 ??  0:01 launchd\");\n");
  // A `node` first on PATH that is not Barry's: a job must never reach it.
  fakeBin = mkdtempSync(join(tmpdir(), "job-runner-bin-"));
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 'not barry node' >&2\nexit 7\n");
  chmodSync(join(fakeBin, "node"), 0o755);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [home, bagDir, fakeBin]) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  closeActionsDb();
});

const greeting = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

function useJobs(jobs: Record<string, unknown>): void {
  const manifest = parseManifestObject({ name: "ops", description: "A bag for testing", jobs }, "ops");
  bags = [{ name: "ops", jobs: Object.entries(manifest.jobs ?? {}).map(([name, job]) => ({ ...job, name, dir: bagDir })) }];
}

async function runJob(job: string, input: Partial<CreateAtScheduleInput> = {}) {
  const { schedule } = createAtSchedule({ bag: "ops", action: null, job, inputs: { name: "barry" }, dueAt: new Date(), ...input });
  const claim = claimOne(schedule.id, { now: new Date(), runnerPid: process.pid, runnerStartedAt: null })!;
  const result = await runJobAtSchedule(claim.schedule, claim.attemptId, claim.attempt, { baseEnv: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
  const run = result.runId ? await ActionRuns.get(result.runId) : null;
  return { result, run, schedule };
}

describe("running a job", () => {
  it("runs a Python process job and checks its output", async () => {
    useJobs({
      greet: {
        input_schema: greeting,
        output_schema: { type: "object", required: ["greeting"] },
        runs: { using: "process", command: ["python3", "jobs/echo.py"] },
      },
    });
    const { result, run, schedule } = await runJob("ops:greet", { idempotencyKey: "step-1" });
    expect(result.outcome).toBe("succeeded");
    expect(run?.trigger).toBe("job");
    expect(run?.action).toBe("ops:job/greet");
    expect(JSON.parse(run!.output!)).toEqual({ greeting: "hello barry", key: "step-1", attempt: "1" });
    expect(schedule.idempotencyKey).toBe("step-1");
  });

  it("runs a TypeScript node job with Barry's own Node, whatever PATH says", async () => {
    useJobs({ greet: { input_schema: greeting, output_schema: { type: "object" }, runs: { using: "node", main: "src/echo.ts" } } });
    const { result, run } = await runJob("ops:greet");
    expect(result, result.reason).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    const output = JSON.parse(run!.output!) as { greeting: string; node: string };
    expect(output.greeting).toBe("hello barry");
    expect(output.node).not.toContain(fakeBin);
  });

  it("keeps free-form stdout when the job declares no output", async () => {
    useJobs({ ps: { runs: { using: "node", main: "src/ps.ts" } } });
    const { result, run } = await runJob("ops:ps", { inputs: {} });
    expect(result.outcome).toBe("succeeded");
    expect(run?.output_type).toBe("text");
    expect(run?.output).toContain("launchd");
  });

  it("fails output that breaks the contract as validation_failed", async () => {
    useJobs({ greet: { input_schema: greeting, output_schema: { type: "object", required: ["missing"] }, runs: { using: "process", command: ["python3", "jobs/echo.py"] } } });
    expect((await runJob("ops:greet")).result.outcome).toBe("validation_failed");
  });

  it("fails a failing validate check as validation_failed", async () => {
    useJobs({ greet: { input_schema: greeting, validate: { command: "false" }, runs: { using: "process", command: ["python3", "jobs/echo.py"] } } });
    expect((await runJob("ops:greet")).result.outcome).toBe("validation_failed");
  });

  it("does not start when preflight does not pass", async () => {
    useJobs({ greet: { input_schema: greeting, preflight: { command: "exit 3", hint: "fix it" }, runs: { using: "process", command: ["python3", "jobs/echo.py"] } } });
    const { result } = await runJob("ops:greet");
    expect(result.outcome).toBe("unavailable");
    expect(result.reason).toMatch(/preflight did not pass/);
  });

  it("refuses inputs the contract refuses, and a job that is gone", async () => {
    useJobs({ greet: { input_schema: greeting, runs: { using: "process", command: ["python3", "jobs/echo.py"] } } });
    expect((await runJob("ops:greet", { inputs: { other: 1 } })).result.outcome).toBe("unavailable");
    expect((await runJob("ops:gone")).result.reason).toMatch(/job "ops:gone" does not exist/);
  });
});

describe("bounds per kind", () => {
  const peek = { type: "object", properties: { paths: { type: "array" } } };

  it("runs a bounded node job under the permission model: its allowlist and nothing else", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "job-runner-allowed-"));
    writeFileSync(join(allowed, "notes.txt"), "ok");
    writeFileSync(join(home, "secret.txt"), "no");
    bounds = { "ops:notes-only": { files: { allow: [`${allowed}/**`] } } };
    useJobs({ peek: { bounds: ["ops:notes-only"], input_schema: peek, output_schema: { type: "object" }, runs: { using: "node", main: "src/peek.mjs" } } });
    const { result, run } = await runJob("ops:peek", { inputs: { paths: [join(allowed, "notes.txt"), join(home, "secret.txt")] } });
    rmSync(allowed, { recursive: true, force: true });
    expect(result.outcome, result.reason).toBe("succeeded");
    expect(JSON.parse(run!.output!)).toEqual({ [join(allowed, "notes.txt")]: "read", [join(home, "secret.txt")]: "ERR_ACCESS_DENIED", child: "ERR_ACCESS_DENIED" });
  });

  it("does not start a bounded node job whose bound Node cannot enforce", async () => {
    bounds = { "ops:no-push": { network: { deny: ["git:push"] } } };
    useJobs({ peek: { bounds: ["ops:no-push"], input_schema: peek, runs: { using: "node", main: "src/peek.mjs" } } });
    const { result, run } = await runJob("ops:peek", { inputs: { paths: [] } });
    expect(result.outcome).toBe("unavailable");
    expect(result.reason).toMatch(/network restriction/);
    expect(run).toBeNull();
  });

  it("does not start a job whose bound does not exist", async () => {
    bounds = {};
    useJobs({ peek: { bounds: ["ops:gone"], input_schema: peek, runs: { using: "node", main: "src/peek.mjs" } } });
    expect((await runJob("ops:peek", { inputs: { paths: [] } })).result.reason).toMatch(/unknown bound ops:gone/);
  });
});

describe("caller authority", () => {
  it("never gives a session-started job its declared secrets", async () => {
    useJobs({ greet: { input_schema: greeting, runs: { using: "process", command: ["python3", "jobs/echo.py"], secrets: ["BARRY_SECRET"] } } });
    const { result, run } = await runJob("ops:greet", { callerSessionId: "sess-1" });
    expect(result.outcome).toBe("unavailable");
    expect(result.reason).toMatch(/declares secrets \(BARRY_SECRET\), which a job a session started cannot have/);
    expect(run).toBeNull();
  });

  it("records the calling session on a session-started run", async () => {
    useJobs({ greet: { input_schema: greeting, runs: { using: "process", command: ["python3", "jobs/echo.py"] } } });
    const { result, run } = await runJob("ops:greet", { callerSessionId: "sess-1" });
    expect(result.outcome).toBe("succeeded");
    expect(run?.session_id).toBe("sess-1");
    expect(run?.metadata.caller_session_id).toBe("sess-1");
  });
});
