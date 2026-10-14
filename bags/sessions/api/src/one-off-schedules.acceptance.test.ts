/**
 * One-off schedules, end to end: a bag outside this repository schedules one
 * of its actions through Platypus; the scheduler ticks before it is due (and
 * starts nothing), then after; the action's script receives its inputs and
 * schedule id, reads a session and records an event through Platypus; and
 * schedules.get reports the outcome with the attempt's run.
 *
 * Real routes (/schedules, /events), the real Scheduler and one-off runner,
 * a real script run by tsx. Only the session read is a stub — the sessions
 * store is a separate service this test does not stand up.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Barry } from "@barry-rocks/sdk";
import { identities, traits } from "@barry-rocks/identities-bag";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";

vi.mock("@barry-rocks/sdk/logging", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/logging")>(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const reminderDeliveries = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/actions-bag", async importOriginal => {
  const actual = await importOriginal<typeof import("@barry-rocks/actions-bag")>();
  return { ...actual, runScriptAction: async (...args: Parameters<typeof actual.runScriptAction>) => {
    const [action, options] = args;
    if (action.run.command === "barry" && action.run.args[0] === "notify") {
      reminderDeliveries(action.run.args.slice(1));
      // Exercise the real process executor while substituting only external notification delivery.
      return actual.runScriptAction({ ...action, run: { command: process.execPath, args: ["-e", "console.log('notification fixture delivered')"] } }, options);
    }
    return actual.runScriptAction(action, options);
  } };
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "one-off-schedules-"));
const bagDir = join(root, "external-bag"); // outside the repository
const actionDir = join(bagDir, "actions", "followup");

// The external bag: its own directory, linking the SDK the way an out-of-repo
// bag does, with one `run:` action whose script uses Platypus.
mkdirSync(actionDir, { recursive: true });
mkdirSync(join(bagDir, "node_modules", "@barry-rocks"), { recursive: true });
symlinkSync(join(REPO, "sdk"), join(bagDir, "node_modules", "@barry-rocks", "sdk"));
writeFileSync(join(bagDir, "package.json"), JSON.stringify({ name: "followups", type: "module", private: true }));
writeFileSync(join(bagDir, "bag.yaml"), "name: followups\ndescription: follows up on sessions\n");
writeFileSync(join(actionDir, "action.yaml"), [
  "name: followup",
  "description: record that a session was followed up",
  "run:",
  `  command: ${join(REPO, "node_modules", ".bin", "tsx")}`,
  "  args: [followup.ts]",
  "input_schema:",
  "  type: object",
  "  properties: { sessionId: { type: string } }",
  "  required: [sessionId]",
  "",
].join("\n"));
writeFileSync(join(actionDir, "followup.ts"), `
  import { readFileSync } from "node:fs";
  import { connectLocal } from "@barry-rocks/sdk/internal/client";
  const { sessionId } = JSON.parse(readFileSync(0, "utf8"));
  const scheduleId = process.env.BARRY_SCHEDULE_ID;
  const barry = await connectLocal();
  const session = await barry.sessions.get(sessionId);
  await barry.events.create({ type: "notification", title: "followed up " + session?.id, data: { scheduleId, name: session?.name } });
  console.log("followed up", session?.id);
`);

process.env.BARRY_HOME = root;
process.env.BARRY_EVENTS_DB = join(root, "events.db");
process.env.BARRY_SCHEDULES_DB = join(root, "schedules.db");
process.env.BARRY_ACTIONS_DB = join(root, "actions.db");

const bag = {
  name: "followups",
  source: { type: "local", path: bagDir },
  skillsDirs: [],
  actionsDirs: [join(bagDir, "actions")],
  instructionsDirs: [],
  manifest: null,
  tools: [],
};
// The bash bag every installation registers: its Bash tool is what a script
// action runs under, and a schedule is granted only tools a bag declares.
const bash = { ...bag, name: "bash", source: { type: "builtin" }, actionsDirs: [], tools: [{ namespace: "bash", toolName: "Bash", access: "write" }] };
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: async () => ({ byName: new Map([bag, bash].map((b) => [b.name, b] as const)), bags: [bag, bash], registry: {} }),
  loadAllBags: async () => [],
  getInvalidManifests: () => new Map(),
}));

const { schedulesRouter } = await import("./routes/schedules.js");
const { apiContractMiddleware } = await import("./http.js");
const { eventsRouter } = await import("@barry-rocks/events-bag");
const { BarryClient } = await import("@barry-rocks/sdk/internal/client");
const { Scheduler } = await import("@barry-rocks/schedules-bag");
const { runOneOff, recoverOneOffs } = await import("@barry-rocks/scheduler-service");

const SESSION = {
  id: "sess_1", name: "Refactor", systemPrompt: null, summary: null, repoPath: null, identityId: null,
  identitySource: null, status: "completed", traits: [], bound: null, pinned: false, useWorktree: false,
  worktreeStatus: null, worktreePath: null, baseRepoPath: null, source: null, provider: "claude",
  model: null, createdAt: "2026-09-24T00:00:00.000Z", startedAt: null,
};

let server: Server;
let apiUrl: string;
beforeAll(async () => {
  // SDK policy resolution reads its own loader, so it needs a real scratch snapshot.
  process.env.BARRY_BAGS_SNAPSHOT = join(root, "bags.snapshot.json");
  writeFileSync(process.env.BARRY_BAGS_SNAPSHOT, JSON.stringify({ bags: {
    followups: { type: "local", path: bagDir },
    bash: { type: "local", path: join(REPO, "bags", "bash") },
  } }));
  const { buildBag } = await import("@barry-rocks/sdk/internal/bags");
  expect((await buildBag({ name: "bash", bagDir: join(REPO, "bags", "bash"), entry: join(REPO, "bags", "bash", "src", "tools.ts") })).ok).toBe(true);
  // The identities subject the runner asks what the schedule is granted, over the scratch store.
  Barry.use(identities);
  await traits.upsert({ name: "fixture-followup-script", namespaces: ["bash"], access: "readwrite" });
  await traits.upsert({ name: "bash", namespaces: ["bash"], access: "readwrite" });
  const app = express();
  app.use(express.json());
  // Mounted as index.ts mounts them: /schedules before the contract
  // middleware, everything else behind it.
  const v1 = express.Router();
  v1.use("/schedules", schedulesRouter);
  v1.use(apiContractMiddleware);
  v1.get("/sessions/:id", (req, res) => (req.params.id === SESSION.id ? res.json(SESSION) : res.status(404).json({ title: "Not Found", status: 404 })));
  v1.use("/events", eventsRouter);
  app.use("/api/v1", v1);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const addr = server.address();
  apiUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  // Write the registry so Platypus (in both the test and the spawned script) finds the API.
  writeServiceRegistry({
    version: 2,
    generated: new Date().toISOString(),
    resources: { "sessions.api": { bag: "sessions", name: "api", kind: "service", url: apiUrl } },
  });
});
afterAll(async () => {
  Barry.reset();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function scheduler() {
  const unused = () => Promise.reject(new Error("no recurring schedules here"));
  return new Scheduler({
    listSchedules: async () => ({ schedules: [], errors: [] }),
    resolveAction: unused,
    runScript: unused,
    runAgent: unused,
    runJob: unused,
    announce: async () => true,
    runOneOff,
    recoverOneOffs: () => void recoverOneOffs(),
    runner: { pid: process.pid, startedAt: null },
    loginEventId: () => null,
    now: () => new Date(),
  });
}

it("an external bag schedules its action, which runs later and calls Barry back", async () => {
  const barry = new BarryClient({ baseUrl: apiUrl, secret: "unused-here" });
  const scheduled = await barry.schedules.schedule(Date.now() + 2_000, {
    action: "followups:followup", traits: ["fixture-followup-script"], inputs: { sessionId: "sess_1" }, idempotencyKey: "followup:sess_1",
  });
  expect(scheduled.status).toBe("pending");

  // Before it is due: the scheduler starts nothing.
  const s = scheduler();
  await s.tick();
  expect(s.running).toHaveLength(0);
  expect((await barry.schedules.get(scheduled.id))!.status).toBe("pending");

  await new Promise((r) => setTimeout(r, 2_200));
  await s.tick();
  expect(s.running).toHaveLength(1);
  await Promise.all(s.running);

  const final = await barry.schedules.get(scheduled.id);
  expect(final, JSON.stringify(final)).toMatchObject({ status: "succeeded", attempts: [{ outcome: "succeeded", exitCode: 0, runId: expect.stringMatching(/^arn_/) }] });

  const { events } = await barry.events.list({ limit: 10 });
  expect(events).toContainEqual(expect.objectContaining({
    title: "followed up sess_1",
    data: { scheduleId: scheduled.id, name: "Refactor" },
  }));
}, 60_000);

it("refuses an action that does not exist, and inputs its schema rejects, before storing anything", async () => {
  const barry = new BarryClient({ baseUrl: apiUrl, secret: "unused-here" });
  await expect(barry.schedules.schedule(Date.now(), { action: "followups:nope" })).rejects.toMatchObject({ status: 404 });
  await expect(barry.schedules.schedule(Date.now(), { action: "followups:followup", traits: ["fixture-followup-script"], inputs: {} })).rejects.toMatchObject({ status: 422 });
  expect(await barry.schedules.list({ bag: "followups", status: "pending" })).toEqual([]);
});

it("refuses raw scheduled execution without selected traits and produces no callback event", async () => {
  const barry = new BarryClient({ baseUrl: apiUrl, secret: "unused-here" });
  const before = await barry.events.list({ limit: 100 });
  const schedule = await barry.schedules.schedule(Date.now(), { action: "followups:followup", inputs: { sessionId: "sess_1" }, traits: [] });
  const runner = scheduler(); await runner.tick(); await Promise.all(runner.running);
  const final = await barry.schedules.get(schedule.id);
  expect(final).toMatchObject({ status: "failed", attempts: [{ runId: null, exitCode: null }] });
  expect(final?.reason).toContain("must explicitly select traits");
  expect(await barry.events.list({ limit: 100 })).toEqual(before);
});

it("the documented reminder creates and fires with explicit permissions", async () => {
  const { createScheduleTool } = await import("@barry-rocks/schedules-bag");
  const description = createScheduleTool.description.split("Example reminder: ")[1].split("\n")[0];
  const spec: Record<string, unknown> = JSON.parse(description);
  // The user chooses a due time; keep every permission and action field from the actual example.
  spec.at = new Date(Date.now() - 1).toISOString();
  const made = await createScheduleTool.handler({ name: "documented-reminder", spec }, { secrets: {}, sessionId: "sess_1" }) as { id: string };
  const runner = scheduler(); await runner.tick(); await Promise.all(runner.running);
  const barry = new BarryClient({ baseUrl: apiUrl, secret: "unused-here" });
  expect(await barry.schedules.get(made.id)).toMatchObject({ status: "succeeded" });
  expect(reminderDeliveries).toHaveBeenCalledExactlyOnceWith(["Standup"]);
}, 60_000);
