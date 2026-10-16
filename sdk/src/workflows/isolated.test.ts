import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import { WorkflowOwner, ProcessExecutor, inspectArtifact, ActivityWorker, connectOwnerV2, dispatchWorkerRequest, snapshotWorkflows, restoreWorkflows } from "./index.js";
import { migrations } from "./migrations.js";
import type { ReplayExecutor } from "./executor.js";
import type { Proposal } from "./evaluator.js";
import { buildArtifact } from "./build-artifact.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { approveWorkflowBounds } from "../bounds/workflow-bounds.js";
import { authorizeRun } from "./approvals.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const artifactPath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
function setup(executor: ReplayExecutor = new ProcessExecutor({ wallMs: 400 })) {
  const root = mkdtempSync(join(tmpdir(), "isolated-workflows-")), path = join(root, "jobs.db");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = ["echo", "loop", "finish"].map(type => inspectArtifact(artifactPath, type, "1"));
  const owner = new WorkflowOwner({ id: "owner", path, artifacts, activityArtifacts: { echo: artifacts[0].digest }, executor });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  return { owner, path, artifacts };
}
it("commits accepted intent before asynchronously evaluating in a child process", async () => {
  const { owner } = setup(new ProcessExecutor());
  expect(owner.start({ id: "job", type: "echo", version: "1", input: "hello" }).status).toBe("running");
  expect(owner.inspect("job").commands).toHaveLength(0);
  await owner.pump();
  const executor = new ProcessExecutor(); cleanup.push(() => executor.close());
  const worker = new ActivityWorker({ connections: [connectOwnerV2("owner", async request => dispatchWorkerRequest(owner, "worker", request))], artifacts: { echo: inspectArtifact(artifactPath, "echo", "1", false).digest }, activities: { echo: executor.activity(inspectArtifact(artifactPath, "echo", "1", false)) } });
  cleanup.push(() => worker.stop());
  await worker.tick();
  for (let count = 0; count < 100 && owner.get("job").status !== "completed"; count++) {
    await new Promise(resolve => setTimeout(resolve, 20)); await worker.tick(); await owner.pump();
  }
  expect(owner.get("job").outcome).toEqual({ ok: true, value: "hello" });
});
it("kills a looping evaluator while reads and unrelated evaluation remain available", async () => {
  const { owner } = setup(new ProcessExecutor());
  owner.start({ id: "bad", type: "loop", version: "1", input: null });
  owner.start({ id: "good", type: "finish", version: "1", input: "ok" });
  const pump = owner.pump();
  expect(owner.get("bad").status).toBe("running");
  await pump;
  for (let count = 0; count < 50 && owner.get("good").status === "running"; count++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    await owner.pump();
  }
  expect(owner.get("bad").status).toBe("blocked");
  expect(owner.get("bad").error).toMatch(/BudgetExceeded/);
  expect(owner.get("good").outcome).toEqual({ ok: true, value: "ok" });
});
it("cannot commit a proposal after cancellation changed the evaluated revision", async () => {
  let release!: (proposal: Proposal) => void;
  const { owner } = setup({ evaluate: () => new Promise(resolve => { release = resolve; }), close: async () => {} });
  owner.start({ id: "job", type: "finish", version: "1", input: null });
  const pending = owner.pump(); owner.cancel("job"); release({ kind: "complete", value: "wrong" }); await pending;
  expect(owner.get("job").status).toBe("cancelled");
});
it("does not turn async proposal storage faults into business failure", async () => {
  const { owner, path } = setup(new ProcessExecutor());
  owner.start({ id: "job", type: "echo", version: "1", input: "hello" });
  const db = new DatabaseSync(path); cleanup.push(() => db.close());
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON workflow_commands BEGIN SELECT RAISE(ABORT,'storage fault'); END");
  await expect(owner.pump()).rejects.toThrow("storage fault");
  expect(owner.get("job").status).toBe("running");
  expect(db.prepare("SELECT count(*) n FROM workflow_groups").get()?.n).toBe(0);
});
it("adopts only the exact legacy baseline and preserves Barry-compatible migration checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-migrations-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.db"), db = new DatabaseSync(path);
  db.exec(migrations[0].sql); db.close();
  const owner = new WorkflowOwner({ id: "owner", path }); owner.close();
  const check = new DatabaseSync(path);
  expect(check.prepare("SELECT count(*) n FROM schema_migrations WHERE checksum IS NOT NULL").get()?.n).toBe(migrations.length);
  check.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run(); check.close();
  expect(() => new WorkflowOwner({ id: "owner", path })).toThrow("checksum");
});

it("resumes bounded legacy byte accounting after restart and refuses new admission until complete", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-backfill-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.db"), legacy = new DatabaseSync(path);
  legacy.exec(migrations[0].sql);
  legacy.prepare("INSERT INTO workflow_runs VALUES('legacy','owner','echo','1','null','{}','completed',1000,2000,'{\"ok\":true,\"value\":null}',NULL)").run();
  const insert = legacy.prepare("INSERT INTO workflow_events(run_id,at,type,details) VALUES('legacy',1000,'Legacy',?)");
  for (let row = 0; row < 200; row++) insert.run(JSON.stringify({ data: "x".repeat(1024) }));
  legacy.close();
  const owner = new WorkflowOwner({ id: "owner", path, definitions: [{ type: "echo", version: "1", *run(input) { yield* []; return input; } }] }); cleanup.push(() => owner.close());
  expect(owner.storageAccounted).toBe(false);
  expect(() => owner.start({ id: "new", type: "echo", version: "1", input: null })).toThrow("accounting is in progress");
  owner.tick(); owner.tick(); owner.tick();
  const inspect = new DatabaseSync(path); cleanup.push(() => inspect.close());
  expect(inspect.prepare("SELECT cursor FROM workflow_byte_backfill").get()?.cursor).toBe(64);
  owner.close();
  const restarted = new WorkflowOwner({ id: "owner", path }); cleanup.push(() => restarted.close());
  restarted.tick();
  expect(inspect.prepare("SELECT cursor FROM workflow_byte_backfill").get()?.cursor).toBe(128);
  for (let turn = 0; turn < 20 && !restarted.storageAccounted; turn++) restarted.tick();
  expect(restarted.storageAccounted).toBe(true);
  const bytes = Number(inspect.prepare("SELECT budget_bytes FROM workflow_runs WHERE id='legacy'").get()?.budget_bytes);
  expect(bytes).toBeGreaterThan(200 * 1024);
  expect(bytes).toBeLessThan(1_048_576);
  expect(Number(inspect.prepare("SELECT value FROM workflow_meta WHERE key='reserved-bytes'").get()?.value)).toBe(bytes);
  expect(inspect.prepare("SELECT count(*) n FROM workflow_byte_backfill").get()?.n).toBe(0);
});

it("snapshots and restores active work paused under a new epoch without overwriting a destination", async () => {
  const { owner, path, artifacts } = setup(new ProcessExecutor());
  owner.start({ id: "job", type: "echo", version: "1", input: "durable" }); await owner.pump();
  owner.openSession("worker", "before-restore");
  owner.advertise("worker", { types: ["echo"], artifacts: { echo: artifacts[0].digest }, capacity: 1 });
  const task = owner.claim("worker")!;
  const backup = `${path}.snapshot`, restored = `${path}.restored`;
  const before = await snapshotWorkflows(path, backup, "owner", artifacts);
  owner.start({ id: "post-snapshot", type: "finish", version: "1", input: "acknowledged but outside this snapshot" });
  await owner.drain(); owner.close();
  expect(() => restoreWorkflows(backup, restored, "owner", false)).toThrow("fenced");
  const after = await restoreWorkflows(backup, restored, "owner", true);
  expect(after.epoch).not.toBe(before.epoch);
  const db = new DatabaseSync(join(restored, "workflows.db"));
  try {
    expect(db.prepare("SELECT status FROM workflow_runs WHERE id='job'").get()?.status).toBe("blocked");
    expect(db.prepare("SELECT 1 FROM workflow_runs WHERE id='post-snapshot'").get()).toBeUndefined();
    expect(db.prepare("SELECT state FROM workflow_attempts WHERE token=?").get(task.token)?.state).toBe("expired");
    expect(db.prepare("SELECT id FROM workflow_commands WHERE id=?").get(task.idempotencyKey)?.id).toBe(task.idempotencyKey);
    expect(db.prepare("SELECT retired FROM workflow_worker_sessions WHERE session='before-restore'").get()?.retired).toBe(1);
  } finally { db.close(); }
  await expect(restoreWorkflows(backup, restored, "owner", true)).rejects.toThrow("destination exists");
});

it("records external session dependencies and refuses automatic resume of unsettled turns", async () => {
  const { owner, path, artifacts } = setup(new ProcessExecutor());
  const job = { identity: "reviewer", traits: [] };
  const scope = await approveWorkflowBounds({ identity: job.identity, bags: [], tools: [], boundByName: async () => undefined });
  const grant = await authorizeRun(job, "author", async () => scope);
  owner.start({ id: "job", type: "echo", version: "1", input: "durable", job }, "author", undefined, grant); await owner.pump();
  owner.advertise("worker", { types: ["echo"], artifacts: { echo: artifacts[0].digest }, capacity: 1 });
  const task = owner.claim("worker")!;
  owner.bindSession("job", task.activityId, "session", "turn");
  const backup = path + ".session-snapshot", restored = path + ".session-restored";
  const manifest = await snapshotWorkflows(path, backup, "owner", artifacts);
  expect(manifest.sessionDependencies).toMatchObject({ kind: "references-only", entries: 1 });
  expect(JSON.parse(readFileSync(join(backup, "session-dependencies.jsonl"), "utf8"))).toMatchObject({ sessionId: "session", turnId: "turn", identity: "reviewer", state: "active" });
  await restoreWorkflows(backup, restored, "owner", true);
  const recovered = new WorkflowOwner({ id: "owner", path: join(restored, "workflows.db"), artifacts, activityArtifacts: { echo: artifacts[0].digest }, executor: new ProcessExecutor() });
  try { expect(() => recovered.resume("job")).toThrow("session turn"); }
  finally { await recovered.drain(); recovered.close(); }
});

it("reconciles a real destination effect after restoring before its result and retries with the same key", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-reconcile-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const destination = new DatabaseSync(join(root, "destination.db")); cleanup.push(() => destination.close());
  destination.exec("CREATE TABLE effects(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE balance(total INTEGER NOT NULL); INSERT INTO balance VALUES(0)");
  let physicalCalls = 0;
  const server = createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += chunk;
    const body = JSON.parse(input) as { key: string; value: number }; physicalCalls++;
    destination.exec("BEGIN IMMEDIATE");
    const old = destination.prepare("SELECT value FROM effects WHERE key=?").get(body.key);
    if (!old) { destination.prepare("INSERT INTO effects VALUES(?,?)").run(body.key, JSON.stringify(body.value)); destination.prepare("UPDATE balance SET total=total+?").run(body.value); }
    destination.exec("COMMIT"); response.end(old ? String(old.value) : JSON.stringify(body.value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const workflow = inspectArtifact(artifactPath, "echo", "1"), activity = inspectArtifact(fileURLToPath(new URL("./effect-fixture.mjs", import.meta.url)), "echo", "1", false);
  const activityExecutor = new ProcessExecutor(); cleanup.push(() => activityExecutor.close());
  const path = join(root, "owner.db"), backup = join(root, "snapshot"), restored = join(root, "restored"), activityArtifacts = { echo: activity.digest };
  const original = new WorkflowOwner({ id: "owner", path, artifacts: [workflow], activityArtifacts, executor: new ProcessExecutor() });
  cleanup.push(async () => { await original.drain(); original.close(); });
  original.start({ id: "payment", type: "echo", version: "1", input: { destination: `http://127.0.0.1:${(server.address() as { port: number }).port}`, value: 7 } }); await original.pump();
  original.openSession("worker", "old"); original.advertise("worker", { types: ["echo"], artifacts: activityArtifacts, capacity: 1 });
  const first = original.claim("worker")!;
  await snapshotWorkflows(path, backup, "owner", [workflow, activity]);
  expect(await activityExecutor.activity(activity)(first.input, { ...first, signal: new AbortController().signal })).toBe(7);
  // The external commit survived; its owner completion was never delivered.
  await original.drain(); original.close();
  await restoreWorkflows(backup, restored, "owner", true);
  const restoredWorkflow = { ...workflow, path: join(restored, `${workflow.digest}.mjs`) };
  const recovered = new WorkflowOwner({ id: "owner", path: join(restored, "workflows.db"), artifacts: [restoredWorkflow], activityArtifacts, executor: new ProcessExecutor() });
  cleanup.push(async () => { await recovered.drain(); recovered.close(); });
  expect(recovered.get("payment").status).toBe("blocked");
  expect(destination.prepare("SELECT value FROM effects WHERE key=?").get(first.idempotencyKey)?.value).toBe("7");
  expect(recovered.complete("worker", first.token, { ok: true, value: 7 })).toBe(false);
  expect(recovered.recoveryAdmission?.active).toBe(false);
  recovered.activateAdmission({ request_id: "c7e6eb20-d9cf-4d76-8b5c-6b54a88931c0", expected_epoch: recovered.recoveryAdmission!.epoch,
    reason: "Destination key proves the committed value and the original child completed before fencing.", residual_risk: "Retry uses the same destination deduplication key; no new invocation replaces unknown work.",
    effect_paths_fenced: true, post_snapshot_work_reviewed: true }, "local-operator");
  recovered.resume("payment"); await recovered.pump();
  recovered.openSession("worker", "new"); recovered.advertise("worker", { types: ["echo"], artifacts: activityArtifacts, capacity: 1 });
  // The persisted fairness cursor may need one empty round to wrap.
  const retry = recovered.claim("worker") ?? recovered.claim("worker")!;
  expect(retry.idempotencyKey).toBe(first.idempotencyKey); expect(retry.attempt).toBe(2);
  const value = await activityExecutor.activity({ ...activity, path: join(restored, `${activity.digest}.mjs`) })(retry.input, { ...retry, signal: new AbortController().signal });
  expect(recovered.complete("worker", retry.token, { ok: true, value })).toBe(true); await recovered.pump();
  expect(recovered.get("payment").outcome).toEqual({ ok: true, value: 7 });
  expect(physicalCalls).toBe(2); expect(destination.prepare("SELECT total FROM balance").get()?.total).toBe(7);
});

it("bundles the public DSL into an immutable closed artifact and double-replays identically", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-bundle-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifact = await buildArtifact({ entry: fileURLToPath(new URL("./authoring-fixture.ts", import.meta.url)), destination: join(root, "artifact.mjs"), type: "bundled", version: "1" });
  const executor = new ProcessExecutor(); cleanup.push(() => executor.close());
  const snapshot = { input: "hello", groups: [] };
  expect(await executor.evaluate(artifact, snapshot)).toEqual(await executor.evaluate(artifact, snapshot));
  await expect(buildArtifact({ entry: fileURLToPath(new URL("./authoring-fixture.ts", import.meta.url)), destination: artifact.path, type: "bundled", version: "1" })).rejects.toThrow();
});

it("terminates non-cooperative module initialization without entering the owner process", async () => {
  const executor = new ProcessExecutor({ wallMs: 200 }); cleanup.push(() => executor.close());
  const artifact = inspectArtifact(fileURLToPath(new URL("./init-loop-fixture.mjs", import.meta.url)), "loop", "1");
  await expect(executor.evaluate(artifact, { input: null, groups: [] })).rejects.toThrow("wall-time budget");
});

it("refuses a hardened profile on non-Linux hosts", () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  try {
    expect(() => new ProcessExecutor({ profile: "hardened" })).toThrow("requires Linux cgroups v2");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("refuses future schemas without changing the database", () => {
  const { owner, path } = setup(); owner.close();
  const db = new DatabaseSync(path); db.exec("PRAGMA user_version=999"); db.close();
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = hash();
  expect(() => new WorkflowOwner({ id: "owner", path })).toThrow("unsupported");
  expect(hash()).toBe(before);
});

it("kills a non-cooperative activity and does not free the executor slot before child exit", async () => {
  const executor = new ProcessExecutor({ maxChildren: 1 }); cleanup.push(() => executor.close());
  const artifact = inspectArtifact(artifactPath, "loop", "1", false), abort = new AbortController();
  const task = { owner: "owner", runId: "run", activityId: "step", idempotencyKey: "key", type: "loop", input: null, attempt: 1, token: "token", deadline: Date.now() + 1000, timeoutMs: 1000, heartbeatMs: 10, signal: abort.signal };
  const first = executor.activity(artifact)(null, task);
  await expect(executor.activity(artifact)(null, task)).rejects.toThrow("capacity");
  abort.abort(); await expect(first).rejects.toThrow("cancelled");
  await executor.close();
});
