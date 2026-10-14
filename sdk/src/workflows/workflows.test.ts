import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ActivityFailure, ActivityWorker, WorkflowOwner, activity, all, connectOwner, dispatchWorkerRequest, now, random, signal, sleep, type Json, type WorkflowDefinition } from "./index.js";

const roots: string[] = [], owners: WorkflowOwner[] = [];
afterEach(() => { for (const owner of owners.splice(0)) { try { owner.close(); } catch { /* Already closed to simulate restart. */ } } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "workflow-contract-")); roots.push(root); return root; }
function runtime(definitions: WorkflowDefinition[], options: { path?: string; id?: string; now?: () => number } = {}) {
  const owner = new WorkflowOwner({ path: options.path ?? join(directory(), "workflows.db"), id: options.id ?? "owner", definitions, now: options.now }); owners.push(owner); return owner;
}
const echo: WorkflowDefinition = { type: "echo", version: "1", *run(input) { return yield activity("echo@1", input, { heartbeatTimeoutMs: 100, attemptTimeoutMs: 500, retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20 } }); } };
const start = (owner: WorkflowOwner, input: Json = "hello", id = "job") => owner.start({ id, type: "echo", version: "1", input });
const advertise = (owner: WorkflowOwner, id = "worker") => owner.advertise(id, { types: ["echo@1"], capacity: 4 });

describe("durable workflow contract", () => {
  it("recovers committed activity intent after the owner process is killed", async () => {
    const path = join(directory(), "workflows.db");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./crash-fixture.ts", import.meta.url)), path], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("crash fixture exited before commit"); })]);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const owner = runtime([{ ...echo, *run(input) { return yield activity("echo@1", input); } }], { path });
      owner.tick(); advertise(owner);
      const task = owner.claim("worker")!;
      expect(task.input).toBe("survived");
      owner.complete("worker", task.token, { ok: true, value: task.input });
      expect(owner.get("crash-job").outcome).toEqual({ ok: true, value: "survived" });
    } finally { child.kill("SIGKILL"); }
  });
  it("reopens scheduled work and recorded time/random without repeating an accepted effect", () => {
    let clock = 1_000;
    const definition: WorkflowDefinition = { type: "echo", version: "1", *run(input) {
      const at = yield now(), entropy = yield random();
      const value = yield activity("echo@1", input);
      yield sleep(50);
      return { at, entropy, value };
    } };
    const path = join(directory(), "workflows.db");
    let owner = runtime([definition], { path, now: () => clock });
    start(owner); advertise(owner);
    const task = owner.claim("worker")!;
    expect(owner.complete("worker", task.token, { ok: true, value: "done" })).toBe(true);
    const entropy = owner.inspect("job").commands[1].outcome;
    owner.close(); clock += 100;
    owner = runtime([definition], { path, now: () => clock }); owner.tick();
    expect(owner.get("job").status).toBe("completed");
    expect(owner.get("job").outcome).toEqual({ ok: true, value: { at: 1_000, entropy: entropy?.ok ? entropy.value : null, value: "done" } });
    advertise(owner); expect(owner.claim("worker")).toBeNull();
    expect(owner.inspect("job").commands[2].attempts).toHaveLength(1);
  });

  it("keeps logical identity across retry and fences old, forged and duplicate responses", () => {
    let clock = 1000;
    const owner = runtime([echo], { now: () => clock }); start(owner); advertise(owner);
    const first = owner.claim("worker")!;
    clock += 100; owner.tick();
    expect(owner.complete("worker", first.token, { ok: true, value: "late" })).toBe(false);
    expect(owner.claim("worker")).toBeNull();
    clock += 10;
    const second = owner.claim("worker")!;
    expect(second.token).not.toBe(first.token);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.attempt).toBe(2);
    expect(owner.complete("impostor", second.token, { ok: true, value: "fake" })).toBe(false);
    expect(owner.complete("worker", second.token, { ok: true, value: "real" })).toBe(true);
    expect(owner.complete("worker", second.token, { ok: true, value: "real" })).toBe(true);
    expect(owner.complete("worker", second.token, { ok: true, value: "different" })).toBe(false);
    expect(owner.get("job").outcome).toEqual({ ok: true, value: "real" });
    expect(owner.history("job").filter(event => event.type === "CommandResolved")).toHaveLength(1);
  });

  it("heartbeats extend a lease but cannot extend the attempt deadline", () => {
    let clock = 1000;
    const owner = runtime([echo], { now: () => clock }); start(owner); advertise(owner);
    const task = owner.claim("worker")!;
    for (let index = 0; index < 5; index++) { clock += 90; expect(owner.heartbeat("worker", task.token)).toBe(true); }
    clock = 1500;
    expect(owner.heartbeat("worker", task.token)).toBe(false);
    expect(owner.complete("worker", task.token, { ok: true, value: "late" })).toBe(false);
  });

  it("retains early signals, consumes them in order, and deduplicates delivery across restart", () => {
    let clock = 1000;
    const definition: WorkflowDefinition = { type: "echo", version: "1", *run() { yield sleep(10); return [yield signal("go"), yield signal("go")]; } };
    const path = join(directory(), "workflows.db");
    let owner = runtime([definition], { path, now: () => clock }); start(owner);
    owner.signal("job", "one", "go", 1); owner.signal("job", "one", "go", 1);
    expect(() => owner.signal("job", "one", "go", 2)).toThrow("different payload");
    owner.signal("job", "two", "go", 2); owner.close(); clock += 10;
    owner = runtime([definition], { path, now: () => clock }); owner.tick();
    expect(owner.get("job").outcome).toEqual({ ok: true, value: [1, 2] });
    expect(owner.signal("job", "two", "go", 2).status).toBe("completed");
    expect(() => owner.signal("job", "three", "go", 3)).toThrow("closed");
  });

  it("makes deadline expiration win over a signal received at the deadline", () => {
    let clock = 1000;
    const owner = runtime([{ type: "echo", version: "1", *run() { try { return yield signal("go", 10); } catch (error) { return (error as ActivityFailure).code; } } }], { now: () => clock });
    start(owner); clock += 10; owner.signal("job", "late", "go", "late");
    expect(owner.get("job").outcome).toEqual({ ok: true, value: "CommandTimeout" });
  });

  it("replays all results in declaration order despite reverse completion order", () => {
    const owner = runtime([{ type: "echo", version: "1", *run() { return yield all([activity("echo@1", 1), activity("echo@1", 2)]); } }]);
    start(owner); advertise(owner); const first = owner.claim("worker")!, second = owner.claim("worker")!;
    owner.complete("worker", second.token, { ok: true, value: second.input });
    expect(owner.get("job").status).toBe("running");
    owner.complete("worker", first.token, { ok: true, value: first.input });
    expect(owner.get("job").outcome).toEqual({ ok: true, value: [1, 2] });
  });

  it("waits for all parallel leaves before throwing a terminal activity failure", () => {
    const owner = runtime([{ type: "echo", version: "1", *run() { try { return yield all([activity("echo@1", 1), activity("echo@1", 2)]); } catch { return "compensated"; } } }]);
    start(owner); advertise(owner); const first = owner.claim("worker")!, second = owner.claim("worker")!;
    owner.complete("worker", first.token, { ok: false, error: { code: "BadInput", message: "invalid", retryable: false } });
    expect(owner.get("job").status).toBe("running");
    owner.complete("worker", second.token, { ok: true, value: null });
    expect(owner.get("job").outcome).toEqual({ ok: true, value: "compensated" });
  });

  it("blocks changed commands and missing definitions, then resumes only with compatible code", () => {
    const path = join(directory(), "workflows.db");
    // Compatibility is independent of whether reopen/fsync exceeds echo's
    // short lease on a busy host. Deadline boundaries have their own tests.
    const testClock = () => 1000;
    let owner = runtime([echo], { path, now: testClock }); start(owner); owner.close();
    owner = runtime([], { path, now: testClock }); owner.tick(); expect(owner.get("job").status).toBe("blocked"); owner.close();
    const changed: WorkflowDefinition = { ...echo, *run() { return yield sleep(1); } };
    owner = runtime([changed], { path, now: testClock }); owner.resume("job"); expect(owner.get("job").error).toMatch(/differs/); owner.close();
    owner = runtime([echo], { path, now: testClock }); owner.resume("job"); advertise(owner);
    const task = owner.claim("worker")!; expect(owner.complete("worker", task.token, { ok: true, value: "restored" })).toBe(true);
    expect(owner.get("job").status).toBe("completed");
    expect(() => owner.resume("job")).toThrow("only blocked");
  });

  it("blocks an early return that would discard recorded work", () => {
    const path = join(directory(), "workflows.db");
    let owner = runtime([echo], { path }); start(owner); owner.close();
    owner = runtime([{ ...echo, *run() { yield* []; return "changed"; } }], { path }); owner.tick();
    expect(owner.get("job").status).toBe("blocked");
  });

  it("selects workers by hard capabilities and soft preference, then falls back on expiry", () => {
    let clock = 1000;
    const owner = runtime([{ ...echo, *run(input) { return yield activity("echo@1", input, { placement: { requires: { gpu: true }, preferNodes: ["preferred"] } }); } }], { now: () => clock });
    start(owner); advertise(owner, "incapable");
    owner.advertise("preferred", { types: ["echo@1"], capacity: 1, labels: { gpu: true } });
    owner.advertise("fallback", { types: ["echo@1"], capacity: 1, labels: { gpu: true } });
    expect(owner.claim("incapable")).toBeNull(); expect(owner.claim("fallback")).toBeNull();
    clock += 15_000;
    owner.advertise("fallback", { types: ["echo@1"], capacity: 1, labels: { gpu: true } });
    expect(owner.claim("fallback")?.type).toBe("echo@1");
  });

  it("refuses a second owner lifetime lock and releases it on close", () => {
    // This proves lock ownership, not whether fsync finishes within a 100ms lease.
    const now = () => 1000;
    const path = join(directory(), "workflows.db"), first = runtime([echo], { path, now });
    expect(() => runtime([echo], { path, now })).toThrow("locked");
    start(first); advertise(first, "one");
    const task = first.claim("one")!; first.close();
    const second = runtime([echo], { path, now }); advertise(second, "two"); expect(second.claim("two")).toBeNull();
    expect(second.complete("one", task.token, { ok: true, value: 1 })).toBe(true);
    expect(second.get("job").status).toBe("completed");
  });

  it("cancels pending and active work, rejecting later outcomes", () => {
    const owner = runtime([echo]); start(owner); advertise(owner); const task = owner.claim("worker")!;
    expect(owner.cancel("job").status).toBe("cancelled");
    expect(owner.heartbeat("worker", task.token)).toBe(false);
    expect(owner.complete("worker", task.token, { ok: true, value: "late" })).toBe(false);
    expect(owner.claim("worker")).toBeNull();
    expect(owner.cancel("job").status).toBe("cancelled");
  });

  it("bounds queue waiting and workflow lifetime even when no worker is eligible", () => {
    let clock = 1000;
    const owner = runtime([{ ...echo, *run(input) { return yield activity("missing", input, { timeoutMs: 10 }); } }], { now: () => clock });
    start(owner); clock += 10; owner.tick(); expect(owner.get("job").status).toBe("failed");
    owner.start({ id: "short", type: "echo", version: "1", input: null, timeoutMs: 5 });
    clock += 5; owner.tick(); expect(owner.get("short").status).toBe("timed_out");
  });

  it("exhausts bounded retries and lets workflow code catch failure", () => {
    let clock = 1000;
    const owner = runtime([{ ...echo, *run(input) { try { return yield activity("echo@1", input, { retry: { maxAttempts: 2, initialDelayMs: 5 } }); } catch (error) { return (error as ActivityFailure).code; } } }], { now: () => clock });
    start(owner); advertise(owner);
    for (let index = 0; index < 2; index++) {
      const task = owner.claim("worker")!;
      owner.complete("worker", task.token, { ok: false, error: { code: "Offline", message: "offline", retryable: true } }); clock += 5;
    }
    expect(owner.get("job").outcome).toEqual({ ok: true, value: "Offline" });
  });

  it("validates JSON and start identity before accepting mutations", () => {
    const owner = runtime([echo]); start(owner, { b: 2, a: 1 });
    expect(start(owner, { a: 1, b: 2 }).status).toBe("running");
    expect(() => start(owner, 2)).toThrow("different start");
    expect(() => start(owner, Number.NaN, "bad")).toThrow();
    // Exercise callers outside TypeScript: Date must not silently serialize.
    expect(() => start(owner, Reflect.construct(Date, []) as Json, "bad")).toThrow("plain JSON");
    expect(() => start(owner, "x".repeat(300_000), "bad")).toThrow("256 KiB");
    expect(owner.list()).toHaveLength(1);
  });

  it("refuses another node's database", () => {
    const path = join(directory(), "workflows.db"); runtime([echo], { path }).close();
    expect(() => runtime([echo], { path, id: "another-owner" })).toThrow("another owner");
  });

  it("bounds an unending stream of commands with a visible blocked state", () => {
    const owner = runtime([{ ...echo, *run() { while (true) yield now(); } }]);
    expect(start(owner).status).toBe("blocked");
    expect(owner.get("job").error).toMatch(/limit/);
  });
});

describe("worker and wire protocol", () => {
  it("renews a live lease while another owner's claim is stalled", async () => {
    let clock = 1000;
    const owner = runtime([echo], { now: () => clock }); start(owner);
    let releaseClaim: (() => void) | undefined;
    const worker = new ActivityWorker({ capacity: 2, now: () => clock,
      connections: [connectOwner(owner.id, async request => dispatchWorkerRequest(owner, "worker", request)), {
        advertise: async () => {}, claim: () => new Promise(resolve => { releaseClaim = () => resolve(null); }),
        heartbeat: async () => true, complete: async () => true,
      }],
      activities: { "echo@1": async (_input, context) => { await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); return null; } },
    });
    const initial = worker.tick(); await setImmediate();
    expect(releaseClaim).toBeDefined();
    clock += 80; await worker.tick(); clock += 30; owner.tick();
    expect(owner.inspect("job").commands[0].state).toBe("leased");
    worker.stop(); releaseClaim!(); await initial;
  });
  it("retries lost completion acknowledgements without rerunning an activity", async () => {
    const owner = runtime([echo]); start(owner);
    let executions = 0, drop = true;
    const connection = connectOwner(owner.id, async request => {
      const response = dispatchWorkerRequest(owner, "worker", request);
      if ((request as { operation: string }).operation === "complete" && drop) { drop = false; throw new Error("lost acknowledgement"); }
      return response;
    });
    const worker = new ActivityWorker({ connections: [connection], activities: { "echo@1": async input => { executions++; return input; } } });
    await worker.tick(); await worker.tick(); await worker.tick();
    expect(owner.get("job").outcome).toEqual({ ok: true, value: "hello" });
    expect(executions).toBe(1); worker.stop();
  });

  it("keeps global capacity while polling multiple independent owners", async () => {
    const first = runtime([echo]), second = runtime([echo], { id: "second" }); start(first); start(second);
    const release: (() => void)[] = [];
    let active = 0, maximum = 0;
    const worker = new ActivityWorker({ capacity: 1,
      connections: [first, second].map(owner => connectOwner(owner.id, async request => dispatchWorkerRequest(owner, "worker", request))),
      activities: { "echo@1": async input => { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => release.push(resolve)); active--; return input; } },
    });
    const waitForActivity = async () => {
      for (let i = 0; i < 50; i++) {
        if (release.length > 0) return;
        await worker.tick();
        if (release.length > 0) return;
        await new Promise(r => setTimeout(r, 10));
      }
    };
    await waitForActivity(); expect(release).toHaveLength(1); release.shift()!(); await setImmediate();
    await waitForActivity(); expect(release).toHaveLength(1); release.shift()!(); await setImmediate(); await worker.tick();
    expect(maximum).toBe(1); expect(first.get("job").status).toBe("completed"); expect(second.get("job").status).toBe("completed"); worker.stop();
  });

  it("rejects unsupported, malformed and identity-forging protocol messages", () => {
    const owner = runtime([echo]); start(owner);
    expect(() => dispatchWorkerRequest(owner, "worker", { version: 2, operation: "claim" })).toThrow();
    expect(() => dispatchWorkerRequest(owner, "worker", { version: 1, operation: "claim", worker: "someone-else" })).toThrow();
    expect(() => dispatchWorkerRequest(owner, "worker", { version: 1, operation: "advertise", advertisement: { types: ["echo@1"], capacity: -1 } })).toThrow();
    expect(owner.inspect("job").commands[0].attempts).toHaveLength(0);
  });
});
