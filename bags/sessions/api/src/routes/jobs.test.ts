import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "http";
import Database from "better-sqlite3";
import { parseManifestObject } from "@barry-rocks/sdk/bags";

let bags: Array<{ name: string; jobs: unknown[] }> = [];
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: vi.fn(async () => ({ bags })),
}));
vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  findAction: vi.fn(async (_bags: unknown, ref: string) => (ref === "ops:triage" ? { qualifiedName: ref, context: "none", prompt: "p", inputSchema: { type: "object", properties: { failure: { type: "string" } } } } : null)),
}));
vi.mock("./actions.js", () => ({ stopDetachedRun: vi.fn(async () => true) }));
vi.mock("./caller-bounds.js", () => ({
  resolveCallerBounds: vi.fn(),
  callerScriptBound: vi.fn(),
  permitsRawProcess: vi.fn(),
}));

import { jobsRouter } from "./jobs.js";
import { callerScriptBound, permitsRawProcess, resolveCallerBounds } from "./caller-bounds.js";
import { setDb, closeDb } from "@barry-rocks/schedules-bag";
import { claimOne, finishAttempt, getAtSchedule } from "@barry-rocks/schedules-bag";
import { setDb as setActionsDb, closeDb as closeActionsDb } from "@barry-rocks/actions-bag";
import { ActionRuns } from "@barry-rocks/actions-bag";

const manifest = parseManifestObject({
  name: "ops",
  description: "A bag for testing",
  jobs: {
    greet: {
      input_schema: { type: "object", properties: { name: { type: "string" } } },
      output_schema: { type: "object" },
      timeout: "2m",
      runs: { using: "process", command: ["python3", "jobs/greet.py"] },
    },
    reaper: { runs: { using: "node", main: "src/reaper.ts", secrets: ["BARRY_SECRET"] } },
    triage: { runs: { using: "action", action: "triage" } },
  },
}, "ops");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/jobs", jobsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  closeDb();
  closeActionsDb();
});

beforeEach(() => {
  vi.clearAllMocks();
  setDb(new Database(":memory:"));
  setActionsDb(new Database(":memory:"));
  bags = [{ name: "ops", jobs: Object.entries(manifest.jobs ?? {}).map(([name, job]) => ({ ...job, name, dir: "/bags/ops" })) }];
  vi.mocked(resolveCallerBounds).mockResolvedValue({ session: { id: "sess-1" }, bags: [], bounds: [], bound: null, narrowed: false } as never);
  vi.mocked(callerScriptBound).mockResolvedValue({} as never);
  vi.mocked(permitsRawProcess).mockReturnValue(true);
});

const post = (path: string, body: unknown = {}) =>
  fetch(`${baseUrl}/jobs${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const start = (ref: string, body: unknown = {}) => post(`/${encodeURIComponent(ref)}/runs`, body);

describe("POST /jobs/:ref/runs", () => {
  it("accepts a run durably, with the job's timeout, and replays a repeated key", async () => {
    const first = await start("ops:greet", { inputs: { name: "barry" }, key: "k1" });
    expect(first.status).toBe(201);
    const { run } = (await first.json()) as { run: { id: string; status: string; job: string; key: string } };
    expect(run).toMatchObject({ job: "ops:greet", status: "pending", key: "k1" });
    expect(getAtSchedule(run.id)).toMatchObject({ job: "ops:greet", action: null, timeoutS: 120, inputs: { name: "barry" } });

    const again = await start("ops:greet", { inputs: { name: "barry" }, key: "k1" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { run: { id: string } }).run.id).toBe(run.id);
    expect((await start("ops:greet", { inputs: { name: "other" }, key: "k1" })).status).toBe(409);
  });

  it("refuses what cannot run, before storing anything", async () => {
    expect((await start("greet")).status).toBe(400);
    expect((await start("ops:gone")).status).toBe(404);
    expect((await start("ops:greet", { inputs: { nope: 1 } })).status).toBe(422);
    expect((await start("ops:greet", { inputs: { name: "x".repeat(70_000) } })).status).toBe(413);
  });

  it("checks an action job's inputs against its action", async () => {
    expect((await start("ops:triage", { inputs: { failure: "ci" } })).status).toBe(201);
    expect((await start("ops:triage", { inputs: { name: "x" } })).status).toBe(422);
  });

  describe("for a calling session", () => {
    it("records the session the run acts for", async () => {
      const res = await start("ops:greet", { callerSessionId: "sess-1" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { run: { callerSessionId: string } }).run.callerSessionId).toBe("sess-1");
    });

    it("refuses a job that declares secrets", async () => {
      const res = await start("ops:reaper", { callerSessionId: "sess-1" });
      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/declares secrets \(BARRY_SECRET\)/);
    });

    it("refuses a code job when the session's own policy cannot run a raw process", async () => {
      vi.mocked(permitsRawProcess).mockReturnValue(false);
      expect((await start("ops:greet", { callerSessionId: "sess-1" })).status).toBe(409);
      // An action job's agent runs with the caller's access; no raw process is involved.
      expect((await start("ops:triage", { callerSessionId: "sess-1" })).status).toBe(201);
    });

    it("refuses an unknown or nested caller as the executor would", async () => {
      vi.mocked(resolveCallerBounds).mockResolvedValue({ status: 404, body: { error: "unknown_caller_session" } });
      const res = await start("ops:greet", { callerSessionId: "nobody" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_caller_session" });
    });
  });
});

describe("GET /jobs/runs/:id and cancel", () => {
  it("reads a finished run's output from its attempt's action run", async () => {
    const { run } = (await (await start("ops:greet", { inputs: { name: "barry" } })).json()) as { run: { id: string } };
    const claim = claimOne(run.id, { now: new Date(), runnerPid: 1, runnerStartedAt: null })!;
    const actionRun = await ActionRuns.create({ action: "ops:job/greet", bag: "ops", trigger: "job", schedule_id: run.id });
    await ActionRuns.finishExecuted(actionRun.id, {
      status: "complete",
      summary: "Exited 0",
      process: { exit_code: 0, duration_ms: 5, log_path: null },
      output: { type: "json", value: JSON.stringify({ greeting: "hello barry" }) },
    });
    finishAttempt({ scheduleId: run.id, attemptId: claim.attemptId, outcome: "succeeded", runId: actionRun.id });

    const res = await fetch(`${baseUrl}/jobs/runs/${run.id}?waitS=1`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: unknown }).run).toMatchObject({
      status: "succeeded", attempts: 1, runId: actionRun.id, outputType: "json", output: JSON.stringify({ greeting: "hello barry" }),
    });
  });

  it("cancels a run that has not started", async () => {
    const { run } = (await (await start("ops:greet")).json()) as { run: { id: string } };
    const res = await post(`/runs/${run.id}/cancel`);
    expect(await res.json()).toEqual({ id: run.id, cancelled: true, status: "cancelled" });
    expect((await fetch(`${baseUrl}/jobs/runs/sch_unknown`)).status).toBe(404);
  });
});
