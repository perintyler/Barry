import { mkdtempSync, rmSync, statSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorkResourceBroker,
  workResourceRequestSchema,
  type WorkResourceLimits,
  type WorkResourceRequest,
} from "./work-resource-broker.js";
import { workReceiptDigest } from "./executor-journal.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
const roots: string[] = [],
  brokers: WorkResourceBroker[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  for (const broker of brokers.splice(0)) broker.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  limits: WorkResourceLimits = {
    host: { kind: "host" },
    endpoint: {
      kind: "endpoint",
      concurrency: 2,
      input_tokens: 100,
      output_tokens: 100,
      cost_micros: 100,
    },
  },
) {
  const root = mkdtempSync(join(tmpdir(), "work-resources-"));
  roots.push(root);
  let now = Date.now();
  const options = {
    path: join(root, "resources.db"),
    broker: "shared-resource-owner",
    limits,
    now: () => now,
  };
  const open = () => {
    const broker = new WorkResourceBroker(options);
    brokers.push(broker);
    return broker;
  };
  return {
    root,
    options,
    open,
    first: open(),
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function request(
  owner: string,
  attempt: string,
  resource = "host",
  pool: WorkResourceRequest["pool"] = "process",
  lane: WorkResourceRequest["lane"] = "unscheduled",
) {
  return workResourceRequestSchema.parse({
    version: 2,
    resource,
    pool,
    lane,
    reserve_before: Date.now() + 60000,
    namespace: {
      installation: owner,
      principal_kind: "identity",
      principal_id: attempt,
      identity_id: attempt,
      caller_session_id: "session",
    },
    binding: {
      version: 2,
      owner,
      work_id: `work-${attempt}`,
      workflow_id: `workflow-${attempt}`,
      activity_id: `activity-${attempt}`,
      attempt_id: attempt,
      request_hash: "a".repeat(64),
      plan_digest: "b".repeat(64),
      grant_ref: "grant",
      grant_revision: 1,
      execution_fence: 1,
      source: {
        digest: "c".repeat(64),
        bytes: 20,
        media_type: "text/javascript",
        owner_identity: null,
        purpose: "source",
      },
    },
  });
}
function receipt(request: WorkResourceRequest, physical: "ceased" | "unknown" = "ceased") {
  const unsigned = {
    ...request.binding,
    deadline: request.reserve_before,
    receipt_ref: `receipt-${request.binding.attempt_id}`,
    revision: 2,
    committed_at: Date.now(),
    physical_state: physical,
    effect_certainty: physical === "ceased" ? ("known" as const) : ("uncertain" as const),
    outcome: physical === "ceased" ? ("cancelled" as const) : ("uncertain" as const),
    stages: [],
    output: null,
    summary: "verified cessation",
    validation: "skipped" as const,
    validation_failures: null,
  };
  return { ...unsigned, receipt_digest: workReceiptDigest(unsigned) };
}
it("shares protected 16+4 host pools across owners and keeps process/agent capacity separate", () => {
  const f = fixture(),
    other = f.open();
  for (let index = 0; index < 16; index++)
    (index % 2 ? other : f.first).acquire([
      request(`owner-${index % 2}`, `agent-${index}`, "host", "agent"),
    ]);
  expect(() => other.acquire([request("second", "overflow", "host", "agent")])).toThrow(/occupied/);
  for (let index = 0; index < 4; index++)
    other.acquire([request("scheduled", `scheduled-${index}`, "host", "agent", "scheduled")]);
  expect(() =>
    f.first.acquire([request("scheduled", "scheduled-overflow", "host", "agent", "scheduled")]),
  ).toThrow(/occupied/);
  expect(f.first.acquire([request("process", "different-pool")])).toHaveLength(1);
});
it("enforces per-caller agent fairness and treats internal work as unscheduled capacity", () => {
  const f = fixture();
  const requests = Array.from({ length: 5 }, (_, index) => ({
    ...request("owner", `same-caller-${index}`, "host", "agent", "internal"),
    namespace: request("owner", "caller").namespace,
  }));
  for (const item of requests.slice(0, 4)) f.first.acquire([item]);
  expect(() => f.first.acquire([requests[4]])).toThrow(/occupied/);
});
it("enforces shared endpoint concurrency, token and exact integer cost allowances", () => {
  const f = fixture({
      endpoint: {
        kind: "endpoint",
        concurrency: 2,
        input_tokens: 15,
        output_tokens: 20,
        cost_micros: 100,
      },
    }),
    other = f.open();
  const first = {
    ...request("owner", "one", "endpoint", "model"),
    input_tokens: 10,
    output_tokens: 5,
    cost_micros: 30,
  };
  const held = f.first.acquire([first])[0];
  expect(() =>
    other.acquire([
      {
        ...request("other", "two", "endpoint", "model"),
        input_tokens: 6,
        output_tokens: 5,
        cost_micros: 30,
      },
    ]),
  ).toThrow(/occupied/);
  expect(() =>
    other.acquire([
      {
        ...request("other", "two", "endpoint", "model"),
        input_tokens: 5,
        output_tokens: 5,
        cost_micros: 71,
      },
    ]),
  ).toThrow(/occupied/);
  other.acquire([
    {
      ...request("other", "two", "endpoint", "model"),
      input_tokens: 5,
      output_tokens: 5,
      cost_micros: 70,
    },
  ]);
  expect(() => f.first.acquire([request("third", "three", "endpoint", "model")])).toThrow(
    /occupied/,
  );
  f.first.settle(held.reservation, receipt(first));
  expect(other.acquire([request("third", "three", "endpoint", "model")])).toHaveLength(1);
});
it("rolls a host/endpoint batch back atomically if either allowance is unavailable", () => {
  const f = fixture({
    host: { kind: "host", processes: { unscheduled: 1, scheduled: 1 } },
    endpoint: {
      kind: "endpoint",
      concurrency: 1,
      input_tokens: 10,
      output_tokens: 10,
      cost_micros: 10,
    },
  });
  f.first.acquire([request("occupied", "endpoint-first", "endpoint", "model")]);
  expect(() =>
    f.first.acquire([
      request("new-owner", "batch"),
      request("new-owner", "batch", "endpoint", "model"),
    ]),
  ).toThrow(/occupied/);
  expect(f.first.acquire([request("third", "host-still-free")])).toHaveLength(1);
});
it("retains unknown reservations through restart/deadline expiry and requires the exact receipt to release", () => {
  const f = fixture({ host: { kind: "host", processes: { unscheduled: 1, scheduled: 1 } } }),
    item = request("owner", "held"),
    held = f.first.acquire([item])[0];
  f.first.markUnknown(held.reservation);
  f.first.close();
  f.advance(100000);
  const restored = f.open();
  expect(restored.inspect(held.reservation)?.state).toBe("unknown");
  expect(restored.acquire([item])[0].reservation).toBe(held.reservation);
  expect(() =>
    restored.acquire([{ ...request("other", "other"), reserve_before: f.now() + 1000 }]),
  ).toThrow(/occupied/);
  expect(() => restored.settle(held.reservation, receipt(item, "unknown"))).toThrow(/Unproven/);
  expect(() => restored.settle(held.reservation, receipt(request("other", "other")))).toThrow(
    /another execution/,
  );
  const proof = receipt(item),
    settled = restored.settle(held.reservation, proof);
  expect(settled.state).toBe("released");
  expect(restored.settle(held.reservation, proof)).toEqual(settled);
});
it.each([true, false])(
  "recovers settlement COMMIT ambiguity with one immutable cessation proof (applied: %s)",
  (applied) => {
    const f = fixture(),
      item = request("owner", "settlement-commit"),
      held = f.first.acquire([item])[0],
      proof = receipt(item),
      db = Reflect.get(f.first, "db") as SqliteDatabase,
      original = db.exec.bind(db);
    vi.spyOn(db, "exec")
      .mockImplementationOnce((sql) => original(sql))
      .mockImplementationOnce((sql) => {
        if (sql === "COMMIT") {
          if (applied) original(sql);
          throw new Error("lost settlement commit acknowledgement");
        }
        return original(sql);
      });
    expect(() => f.first.settle(held.reservation, proof)).toThrow(/acknowledgement/);
    const settled = f.first.settle(held.reservation, proof);
    expect(settled.state).toBe("released");
    expect(settled.revision).toBe(2);
    expect(f.first.settle(held.reservation, proof)).toEqual(settled);
    expect(f.first.markUnknown(held.reservation)).toEqual(settled);
    const changed = { ...proof, summary: "different proof" },
      { receipt_digest: _digest, ...unsigned } = changed;
    expect(() =>
      f.first.settle(held.reservation, {
        ...unsigned,
        receipt_digest: workReceiptDigest(unsigned),
      }),
    ).toThrow(/immutable/);
    // A repeated acquire acknowledges the old reservation, never authorizes a new launch.
    expect(f.first.acquire([item])[0]).toEqual(settled);
  },
);
it.each([true, false])(
  "recovers acquire COMMIT ambiguity without another reservation (applied: %s)",
  (applied) => {
    const f = fixture(),
      item = request("owner", "commit"),
      db = Reflect.get(f.first, "db") as SqliteDatabase,
      original = db.exec.bind(db);
    vi.spyOn(db, "exec")
      .mockImplementationOnce((sql) => original(sql))
      .mockImplementationOnce((sql) => {
        if (sql === "COMMIT") {
          if (applied) original(sql);
          throw new Error("lost resource commit acknowledgement");
        }
        return original(sql);
      });
    expect(() => f.first.acquire([item])).toThrow(/acknowledgement/);
    const held = f.first.acquire([item])[0];
    expect(f.first.acquire([item])[0]).toEqual(held);
    const inspect = new SqliteDatabase(f.options.path);
    expect(inspect.prepare("SELECT count(*) n FROM resource_reservations").get()?.n).toBe(1);
    inspect.close();
  },
);
it("arbitrates the same durable host slot across independent OS processes", async () => {
  const f = fixture({ host: { kind: "host", processes: { unscheduled: 1, scheduled: 1 } } });
  const module = new URL("../../dist/workflows/work-resource-broker.js", import.meta.url).href;
  const run = (owner: string) =>
    new Promise<{ state?: string; code?: string }>((resolve, reject) => {
      const code = `
        import { WorkResourceBroker } from ${JSON.stringify(module)};
        const broker = new WorkResourceBroker(${JSON.stringify({
          path: f.options.path,
          broker: f.options.broker,
          limits: f.options.limits,
        })});
        process.stdin.once('data', () => {
          try {
            const held = broker.acquire([${JSON.stringify(request(owner, owner))}])[0];
            process.stdout.write(JSON.stringify({state: held.state}));
          } catch (error) {
            process.stdout.write(JSON.stringify({code: error.code}));
          } finally { broker.close(); process.stdin.destroy(); }
        });
        process.stdout.write('ready\\n');
      `;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output === "ready\n") child.stdin.write("acquire\n");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (status) => {
        if (status !== 0) return reject(new Error(errors || `broker child exited ${status}`));
        try {
          resolve(JSON.parse(output.slice("ready\n".length)));
        } catch (error) {
          reject(error);
        }
      });
    });
  const results = await Promise.all([run("process-one"), run("process-two")]);
  expect(results.filter((result) => result.state === "held")).toHaveLength(1);
  expect(results.filter((result) => result.code === "ResourceBusy")).toHaveLength(1);
  // Process exit is not settlement evidence: the durable arbiter still refuses capacity.
  expect(() => f.first.acquire([request("third", "after-process-exit")])).toThrow(/occupied/);
});
it("keeps reservation evidence private and refuses symlink or hardlink aliases", () => {
  const f = fixture();
  f.first.acquire([request("owner", "private")]);
  for (const path of [f.options.path, `${f.options.path}-wal`, `${f.options.path}-shm`])
    expect(statSync(path).mode & 0o777).toBe(0o600);
  f.first.close();
  const alias = join(f.root, "alias.db");
  symlinkSync(f.options.path, alias);
  expect(() => new WorkResourceBroker({ ...f.options, path: alias })).toThrow(/owned regular/);
  rmSync(alias);
  linkSync(f.options.path, alias);
  expect(() => new WorkResourceBroker({ ...f.options, path: alias })).toThrow(/owned regular/);
});
it("refuses key reuse, accidental capacity reconfiguration and foreign broker identity", () => {
  const f = fixture(),
    item = request("owner", "fixed");
  f.first.acquire([item]);
  expect(() => f.first.acquire([{ ...item, pool: "agent" }])).toThrow(/different execution/);
  expect(() => new WorkResourceBroker({ ...f.options, broker: "foreign" })).toThrow(
    /identity or limits/,
  );
  expect(
    () =>
      new WorkResourceBroker({ ...f.options, limits: { host: { kind: "host", guarded: 100 } } }),
  ).toThrow(/identity or limits/);
});
it("keeps shared physical capacity occupied through a real child's death and owner-handle loss", async () => {
  const f = fixture({ host: { kind: "host", processes: { unscheduled: 1, scheduled: 1 } } }),
    other = f.open(),
    item = request("one", "real-child"),
    held = f.first.acquire([item])[0];
  const child = spawn(process.execPath, ["--permission", "--eval", "setTimeout(()=>{},30000)"], {
    stdio: "ignore",
    env: {},
  });
  children.push(child);
  await once(child, "spawn");
  f.first.markUnknown(held.reservation);
  f.first.close();
  expect(() => other.acquire([request("two", "while-live")])).toThrow(/occupied/);
  const stopped = once(child, "exit");
  child.kill("SIGKILL");
  await stopped;
  expect(() => other.acquire([request("two", "after-death-without-proof")])).toThrow(/occupied/);
  other.settle(held.reservation, receipt(item));
  expect(other.acquire([request("two", "after-confirmed-stop")])).toHaveLength(1);
});
