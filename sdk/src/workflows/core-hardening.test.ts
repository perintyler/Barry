import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProcessExecutor } from "./executor.js";
import { inspectArtifact } from "./artifacts.js";
import { snapshotWorkflows } from "./recovery.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { migrations } from "./migrations.js";
import * as childProcess from "node:child_process";
import { installedJobs } from "./job-registry.js";
import { jobActivity } from "./job-activity.js";
import { WorkflowOwner } from "./workflow-owner.js";
import { ActivityWorker } from "./activity-worker.js";
import { WorkerCredentialRejected } from "./worker-client.js";
import { connectOwnerV2, dispatchWorkerRequest } from "./protocol.js";
import { activity, type ActivityContext, type OwnerConnection } from "./types.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), "barry-core-hardening-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const task = (): ActivityContext => ({
  owner: "owner",
  runId: "run",
  activityId: "step",
  idempotencyKey: "run/step",
  type: "probe:work@1",
  input: {},
  attempt: 1,
  token: "token",
  deadline: Date.now() + 60000,
  timeoutMs: 60000,
  heartbeatMs: 1,
  signal: new AbortController().signal,
});
const code = (version: string) =>
  `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({version:${JSON.stringify(version)}})));`;
async function registered() {
  const dir = directory();
  writeFileSync(join(dir, "work.mjs"), code("registered"));
  const {
    jobs: [job],
  } = await installedJobs(
    [
      {
        name: "probe",
        jobs: [
          {
            name: "work",
            dir,
            version: "1",
            bounds: ["local-only"],
            runs: { using: "node", main: "work.mjs" },
            requires: { bins: [] },
            outputSchema: { type: "object" },
          },
        ],
      },
    ],
    async () => ({ files: { allow: [] }, nodes: { allow: ["local"] } }),
  );
  expect(job).toBeDefined();
  return job;
}
it("never launches changed job bytes under the accepted registry digest", async () => {
  const job = await registered();
  writeFileSync(job.main, code("changed"));
  await expect(jobActivity(job)({}, task())).rejects.toThrow(/digest mismatch/);
});
it("enforces registry job node bounds even when a remote worker advertises the matching digest", async () => {
  const job = await registered();
  const owner = new WorkflowOwner({
    id: "owner",
    path: ":memory:",
    jobs: [job.contract],
    definitions: [
      {
        type: "job",
        version: "1",
        *run() {
          return yield activity(job.type, {}, { placement: { nodes: { allow: ["local", "remote"] } } });
        },
      },
    ],
  });
  cleanup.push(() => owner.close());
  owner.advertise("remote", {
    types: [job.type],
    artifacts: { [job.type]: job.contract.digest },
    capacity: 1,
  });
  owner.start({ id: "run", type: "job", version: "1", input: { job: job.type, input: {} } });
  expect(owner.claim("remote")).toBeNull();
  owner.advertise("owner", {
    types: [job.type],
    artifacts: { [job.type]: job.contract.digest },
    capacity: 1,
  });
  expect(owner.claim("owner")?.type).toBe(job.type);
});
it("retains capacity after credential rejection until an abort-ignoring execution physically returns", async () => {
  let revoked = false,
    clock = 0,
    physical = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  const claimed = new Set<string>();
  function connection(name: string): OwnerConnection {
    return {
      advertise: async () => {
        if (name === "A" && revoked) throw new WorkerCredentialRejected(401);
      },
      claim: async () => {
        if (claimed.has(name)) return null;
        claimed.add(name);
        const { signal: _, ...base } = task();
        return { ...base, owner: name, token: name };
      },
      heartbeat: async () => {
        if (name === "A" && revoked) throw new WorkerCredentialRejected(401);
        return true;
      },
      complete: async () => true,
      settlePhysical: async () => true,
    };
  }
  const worker = new ActivityWorker({
    connections: [connection("A"), connection("B")],
    capacity: 1,
    now: () => clock,
    activities: {
      "probe:work@1": async () => {
        physical++;
        peak = Math.max(peak, physical);
        await new Promise<void>((resolve) => releases.push(resolve));
        physical--;
        return null;
      },
    },
  });
  try {
    await worker.tick();
    expect(physical).toBe(1);
    revoked = true;
    clock = 10;
    for (let i = 0; i < 10; i++) await worker.tick();
    expect(peak).toBe(1);
  } finally {
    releases.forEach((release) => release());
    expect(await worker.drain(1000)).toBe(true);
  }
});
it("accepts 10000 tiny terminal runs on real SQLite/WAL and preserves duplicate lookup after restart", () => {
  const path = join(directory(), "owner.db");
  const options = {
    id: "owner",
    path,
    definitions: [
      {
        type: "noop",
        version: "1",
        *run() {
          yield* [];
          return null;
        },
      },
    ],
  };
  const owner = new WorkflowOwner(options);
  try {
    const began = performance.now();
    for (let index = 0; index < 10000; index++)
      expect(
        owner.start({ id: `tiny-${index}`, type: "noop", version: "1", input: null }).status,
      ).toBe("completed");
    const retainedBytes = statSync(path).size + statSync(`${path}-wal`).size;
    expect(retainedBytes).toBeLessThan(100 * 1024 * 1024);
    process.stdout.write(
      JSON.stringify({
        test: "p1-10000-terminal-runs",
        elapsedMs: performance.now() - began,
        sqliteAndWalBytes: retainedBytes,
        node: process.version,
      }) + "\n",
    );
  } finally {
    owner.close();
  }
  const restarted = new WorkflowOwner(options);
  try {
    expect(restarted.start({ id: "tiny-0", type: "noop", version: "1", input: null }).status).toBe(
      "completed",
    );
    expect(() =>
      restarted.start({ id: "tiny-0", type: "noop", version: "1", input: "changed" }),
    ).toThrow(/different start request/);
  } finally {
    restarted.close();
  }
}, 120000);

it("executes the verified job bytes when its registered path changes during spawn", async () => {
  const job = await registered();
  const original = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
  const spy = vi
    .spyOn(childProcess, "spawn")
    .mockImplementation((...args: Parameters<typeof original>) => {
      writeFileSync(job.main, code("raced"));
      return original(...args);
    });
  try {
    expect(await jobActivity(job)({}, task())).toEqual({ version: "registered" });
  } finally {
    spy.mockRestore();
  }
});
it("refuses missing source before launching a job", async () => {
  const job = await registered();
  rmSync(job.main);
  await expect(jobActivity(job)({}, task())).rejects.toThrow(/ENOENT/);
});
it("keeps legacy contracts local and refuses changing pinned constraints in place", async () => {
  const job = await registered();
  const { nodes: _, ...legacy } = job.contract;
  const path = join(directory(), "legacy.db");
  const options = {
    id: "owner",
    path,
    jobs: [legacy],
    definitions: [
      {
        type: "job",
        version: "1",
        *run() {
          return yield activity(job.type, {});
        },
      },
    ],
  };
  const owner = new WorkflowOwner(options);
  owner.advertise("remote", {
    types: [job.type],
    artifacts: { [job.type]: job.contract.digest },
    capacity: 1,
  });
  try {
    owner.start({ id: "legacy", type: "job", version: "1", input: { job: job.type, input: {} } });
    expect(owner.claim("remote", "retry")).toBeNull();
    expect(owner.claim("remote", "retry")).toBeNull();
  } finally {
    owner.close();
  }
  const compatible = new WorkflowOwner(options);
  compatible.close();
  expect(() => new WorkflowOwner({ ...options, jobs: [{ ...legacy, nodes: {} }] })).toThrow(
    /changed its contract in place/,
  );
});

it("refuses disk-pressure admission while preserving cancellation and settlement controls", async () => {
  const job = await registered();
  const owner = new WorkflowOwner({
    id: "owner",
    path: join(directory(), "pressure.db"),
    jobs: [job.contract],
    definitions: [
      {
        type: "job",
        version: "1",
        *run() {
          return yield activity(job.type, {});
        },
      },
    ],
  });
  owner.start({ id: "active", type: "job", version: "1", input: { job: job.type, input: {} } });
  owner.advertise("owner", {
    types: [job.type],
    artifacts: { [job.type]: job.contract.digest },
    capacity: 1,
  });
  const execution = owner.claim("owner")!;
  const statfs = (await vi.importActual<typeof fs>("node:fs")).statfsSync;
  const spy = vi
    .spyOn(fs, "statfsSync")
    .mockImplementation(
      (...args: Parameters<typeof statfs>) =>
        ({ ...statfs(...args), bavail: 0 }) as ReturnType<typeof statfs>,
    );
  try {
    expect(() =>
      owner.start({
        id: "refused",
        type: "job",
        version: "1",
        input: { job: job.type, input: {} },
      }),
    ).toThrow(/high-water/);
    expect(owner.cancel("active").status).toBe("cancelled");
    expect(owner.prune(Date.now() + 1)).toBe(false);
    expect(owner.settlePhysical("owner", execution.token)).toBe(true);
    expect(owner.prune(Date.now() + 1, () => false)).toBe(false);
    expect(owner.get("active").status).toBe("cancelled");
    expect(owner.prune(Date.now() + 1, () => true)).toBe(true);
    expect(owner.get("active").error).toContain("RunArchived");
  } finally {
    spy.mockRestore();
    owner.close();
  }
});
it("upgrades a v5 SQLite store with active and terminal work without erasing evidence", () => {
  const path = join(directory(), "upgrade.db");
  const db = new SqliteDatabase(path);
  db.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT(datetime('now')),checksum TEXT)",
  );
  for (const [index, migration] of migrations.slice(0, 5).entries()) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)").run(
      index + 1,
      migration.name,
      createHash("sha256").update(migration.sql).digest("hex"),
    );
  }
  db.prepare("INSERT INTO workflow_meta VALUES('owner','owner')").run();
  db.prepare(
    "INSERT INTO workflow_runs(id,owner,type,version,input,request,status,started_at,deadline,budget_bytes) VALUES('terminal','owner','noop','1','null','{}','completed',1,2,1048576)",
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs(id,owner,type,version,input,request,status,started_at,deadline,budget_bytes) VALUES('active','owner','noop','1','null','{}','blocked',1,9999999999999,1048576)",
  ).run();
  db.prepare(
    "INSERT INTO workflow_events(run_id,at,type,details) VALUES('terminal',1,'Evidence','{\"receipt\":\"preserved\"}')",
  ).run();
  db.exec("PRAGMA user_version=5");
  db.close();
  const owner = new WorkflowOwner({ id: "owner", path });
  try {
    expect(owner.storageAccounted).toBe(false);
    // Two retained runs now include resource-intent accounting as another bounded phase.
    for (let i = 0; i < 48 && !owner.storageAccounted; i++) owner.tick();
    expect(owner.storageAccounted).toBe(true);
    expect(owner.get("active").status).toBe("blocked");
    expect(owner.history("terminal")[0].details).toEqual({ receipt: "preserved" });
    const check = new SqliteDatabase(path);
    try {
      expect(
        Number(
          check.prepare("SELECT budget_bytes FROM workflow_runs WHERE id='terminal'").get()
            ?.budget_bytes,
        ),
      ).toBeLessThan(4096);
      expect(
        Number(
          check.prepare("SELECT budget_bytes FROM workflow_runs WHERE id='active'").get()
            ?.budget_bytes,
        ),
      ).toBeGreaterThanOrEqual(1048576);
    } finally {
      check.close();
    }
  } finally {
    owner.close();
  }
});

it.each(["revoked", "partition", "lease-loss", "deadline"])(
  "keeps two-owner capacity one through a real child ignoring abort: %s",
  async (failure) => {
    let clock = 0;
    const epoch = Date.now(), events: Record<string, unknown>[] = [];
    const event = (kind: string, data: Record<string, unknown> = {}) => { events.push({ kind, clock, elapsed: Date.now() - epoch, ...data }); };
    // Lease transitions use one explicit clock. Native child close remains a
    // real OS event; event-loop load cannot expire an unrelated owner's lease.
    const owners = ["A", "B"].map(
      (id) =>
        new WorkflowOwner({
          id,
          now: () => epoch + clock,
          path: join(directory(), `${id}.db`),
          definitions: [
            {
              type: "child",
              version: "1",
              *run() {
                return yield activity("child", null, {
                  attemptTimeoutMs: 1000,
                  heartbeatTimeoutMs: 30,
                  retry: { maxAttempts: 1 },
                });
              },
            },
          ],
        }),
    );
    let failed = false,
      physical = 0,
      peak = 0,
      launches = 0;
    const children = new Set<ReturnType<typeof childProcess.spawn>>();
    const connections = owners.map((owner) => {
      const base = connectOwnerV2(owner.id, async (request) =>
        dispatchWorkerRequest(owner, "worker", request),
      );
      return {
        ...base,
        advertise: async advertisement => { event("advertise", { owner: owner.id, capacity: advertisement.capacity }); return base.advertise(advertisement); },
        claim: async (requestId?: string) => {
          const started = performance.now();
          const claimed = await base.claim(requestId); event("claim", { owner: owner.id, token: claimed?.token ?? null });
          return claimed && failure === "deadline" && owner.id === "A"
            ? { ...claimed, timeoutMs: Math.ceil(performance.now() - started) + 50 }
            : claimed;
        },
        heartbeat: async (token: string) => {
          event("heartbeat", { owner: owner.id, token, failed });
          if (owner.id === "A" && failed) {
            if (failure === "revoked") throw new WorkerCredentialRejected(401);
            if (failure === "partition") throw new Error("transport partition");
            if (failure === "lease-loss") return false;
          }
          const live = await base.heartbeat(token); event("heartbeat-result", { owner: owner.id, live }); return live;
        },
      };
    });
    const worker = new ActivityWorker({
      connections,
      capacity: 1,
      now: () => clock,
      activities: {
        child: async () => {
          launches++; event("launch", { launches });
          physical++;
          peak = Math.max(peak, physical);
          // Pure, bounded real child deliberately ignores the activity AbortSignal.
          const child = childProcess.spawn(
            process.execPath,
            ["--permission", "--eval", "setTimeout(()=>{}, 200)"],
            { stdio: "ignore", env: {} },
          );
          children.add(child);
          await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", () => {
              children.delete(child);
              physical--; event("physical-close", { physical });
              resolve();
            });
          });
          return null;
        },
      },
    });
    try {
      owners.forEach((owner) =>
        owner.start({ id: "run", type: "child", version: "1", input: null }),
      );
      await expect
        .poll(async () => {
          await worker.tick();
          return launches;
        })
        .toBe(1);
      failed = true;
      clock = 100; event("lease-transition", { failure });
      for (let i = 0; i < 8; i++) await worker.tick();
      expect(physical).toBe(1);
      expect(launches).toBe(1);
      await expect
        .poll(
          async () => {
            await worker.tick();
            return launches;
          },
          { timeout: 4000, interval: 10 },
        )
        .toBe(2);
      expect(peak).toBe(1);
    } catch (error) { console.error("two-owner lifecycle trace", JSON.stringify(events)); throw error;
    } finally {
      if (process.env.BARRY_WORK_LIFECYCLE_TRACE) writeFileSync(`${process.env.BARRY_WORK_LIFECYCLE_TRACE}-${failure}.json`, JSON.stringify({ failure, events }, null, 2));
      children.forEach((child) => child.kill("SIGKILL"));
      expect(await worker.drain(2000)).toBe(true);
      owners.forEach((owner) => owner.close());
    }
  },
);

it("runs registry jobs through the production workflow artifact, protocol and bounded child and snapshots all pinned code", async () => {
  const job = await registered();
  const artifact = inspectArtifact(fileURLToPath(new URL("../../../bags/workflows/src/job-artifact.mjs", import.meta.url)), "job", "1");
  const executor = new ProcessExecutor();
  const path = join(directory(), "full-path.db");
  const owner = new WorkflowOwner({ id: "owner", path, jobs: [job.contract], artifacts: [artifact], executor });
  const worker = new ActivityWorker({ connections: [connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, owner.id, request))], activities: { [job.type]: jobActivity(job) }, artifacts: { [job.type]: job.contract.digest }, capacity: 1 });
  try {
    owner.start({ id: "full-path", type: "job", version: "1", input: { job: job.type, input: {} } });
    await expect.poll(async () => { await owner.pump(); await worker.tick(); return owner.get("full-path").status; }, { timeout: 5000, interval: 10 }).toBe("completed");
    expect(owner.get("full-path").outcome).toEqual({ ok: true, value: { version: "registered" } });
    const backup = await snapshotWorkflows(path, join(directory(), "snapshot"), owner.id, [artifact, inspectArtifact(job.main, job.type, "1", false)]);
    expect(backup.artifacts.some(item => item.digest === job.contract.digest)).toBe(true);
  } finally { expect(await worker.drain(1000)).toBe(true); await owner.drain(); owner.close(); }
});

it.runIf(process.env.BARRY_TEST_STORAGE_PRESSURE_ROOT)("refuses admission under actual bounded-filesystem pressure while cancellation remains durable", () => {
  const root = mkdtempSync(join(process.env.BARRY_TEST_STORAGE_PRESSURE_ROOT!, "workflow-pressure-"));
  const path = join(root, "owner.db");
  const owner = new WorkflowOwner({ id: "owner", path, definitions: [{ type: "wait", version: "1", *run() { return yield activity("never-launched", null); } }] });
  try {
    owner.start({ id: "accepted", type: "wait", version: "1", input: null });
    writeFileSync(join(root, "disk-pressure"), Buffer.alloc(90 * 1024 * 1024, 1));
    const disk = fs.statfsSync(root);
    expect(disk.bavail * disk.bsize).toBeLessThan(256 * 1024 * 1024);
    expect(() => owner.start({ id: "refused", type: "wait", version: "1", input: null })).toThrow(/high-water/);
    expect(owner.cancel("accepted").status).toBe("cancelled");
    expect(owner.history("accepted").some(event => event.type === "WorkflowClosed")).toBe(true);
    process.stdout.write(JSON.stringify({ test: "p1-real-filesystem-pressure", freeBytes: disk.bavail * disk.bsize, cancelled: true }) + "\n");
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

it("separates an expired pre-start lease from a native process lifetime", async () => {
  let clock = Date.now();
  const owner = new WorkflowOwner({ id: "lease-probe", path: join(directory(), "lease.db"), now: () => clock,
    definitions: [{ type: "probe", version: "1", *run() { return yield activity("probe", null, { heartbeatTimeoutMs: 30, retry: { maxAttempts: 1 } }); } }] });
  try {
    owner.start({ id: "run", type: "probe", version: "1", input: null });
    const client = connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, "worker", request));
    await client.advertise({ types: ["probe"], capacity: 1, labels: {}, artifacts: {} });
    const task = await client.claim(); expect(task).not.toBeNull();
    clock += 31;
    expect(await client.heartbeat(task!.token)).toBe(false);
    // A scheduling delay beyond the original fixture's 30 ms lease can reject
    // a claim before any child launches. Increasing its four-second poll cannot repair that lease.
  } finally { owner.close(); }
});
