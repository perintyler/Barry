import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { CgroupContainment } from "./cgroups.js";
import { ProcessExecutor } from "../executor.js";
import { WorkflowOwner } from "../workflow-owner.js";
import { ActivityWorker } from "../activity-worker.js";
import { inspectArtifact } from "../artifacts.js";
import { connectOwnerV2, dispatchWorkerRequest } from "../protocol.js";

// Opt-in is explicit: this acceptance test needs a real delegated systemd user manager.
// CI sets this on Linux after starting the user's manager; macOS runs portable.
it.runIf(process.env.BARRY_TEST_HARDENED_SYSTEMD === "1")("observes MemoryMax in a transient scope and fails an OOM activity", async () => {
  expect(process.platform).toBe("linux");
  const memory = 64 * 1024 * 1024;
  const containment = new CgroupContainment({ memoryMaxBytes: memory });
  expect(containment.isAvailable).toBe(true);
  const invocation = containment.wrapSpawn(process.execPath, ["-e", `const fs=require('fs'); const path=fs.readFileSync('/proc/self/cgroup','utf8').trim().split(':').at(-1); console.log(JSON.stringify({path,memory:Number(fs.readFileSync('/sys/fs/cgroup'+path+'/memory.max','utf8'))}));`], { hardened: true });
  const observed = JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: "utf8" }));
  expect(observed.path).toMatch(/\.scope$/);
  expect(observed.memory).toBe(memory);

  const root = mkdtempSync(join(tmpdir(), "hardened-oom-"));
  const artifactPath = join(root, "oom.mjs");
  writeFileSync(artifactPath, `const report = async (input) => (await fetch(input.destination, {method:"POST",body:JSON.stringify({pid:process.pid,oom:input.oom})})).json(); export const activities = { scope: report, oom: async (input) => { await report(input); const allocated=[]; for (;;) allocated.push(Buffer.alloc(256*1024*1024,1)); } };`);
  const artifact = inspectArtifact(artifactPath, "oom", "1", false);
  const executor = new ProcessExecutor({ profile: "hardened", heapMiB: 64 });
  let oomEventsPath: string | undefined;
  let previousOomKills = 0;
  const oomKills = (path: string) => Number(/^oom_kill (\d+)$/m.exec(readFileSync(path, "utf8"))?.[1]);
  const destination = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    const { pid, oom } = JSON.parse(raw) as { pid: number; oom?: boolean };
    const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split(":").at(-1)!;
    const memory = Number(readFileSync(`/sys/fs/cgroup${path}/memory.max`, "utf8"));
    const swap = Number(readFileSync(`/sys/fs/cgroup${path}/memory.swap.max`, "utf8"));
    if (oom) {
      // The parent survives transient-scope cleanup and retains hierarchical OOM counters.
      oomEventsPath = `/sys/fs/cgroup${dirname(path)}/memory.events`;
      previousOomKills = oomKills(oomEventsPath);
    }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ path, memory, swap }));
  });
  await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve));
  const destinationUrl = `http://127.0.0.1:${(destination.address() as { port: number }).port}`;
  const scopeArtifact = inspectArtifact(artifactPath, "scope", "1", false);
  const owner = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), activityArtifacts: { oom: artifact.digest, scope: scopeArtifact.digest }, definitions: [{ type: "scope", version: "1", *run(input) { return yield { kind: "activity", type: "scope", input, attemptTimeoutMs: 20000, heartbeatTimeoutMs: 10000, retry: { maxAttempts: 1 } }; } }, { type: "oom", version: "1", *run(input) { return yield { kind: "activity", type: "oom", input, attemptTimeoutMs: 20000, heartbeatTimeoutMs: 10000, retry: { maxAttempts: 1 } }; } }] });
  const worker = new ActivityWorker({ connections: [connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, "worker", request))], activities: { oom: executor.activity(artifact), scope: executor.activity(scopeArtifact) }, artifacts: { oom: artifact.digest, scope: scopeArtifact.digest }, capacity: 1 });
  try {
    owner.start({ id: "scope", type: "scope", version: "1", input: { destination: destinationUrl } });
    const scopeDeadline = Date.now() + 25000;
    while (owner.get("scope").status === "running" && Date.now() < scopeDeadline) { owner.tick(); await worker.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(owner.get("scope").outcome).toMatchObject({ ok: true, value: { path: expect.stringMatching(/\.scope$/), memory: 64 * 1024 * 1024 * 1.5, swap: 0 } });
    owner.start({ id: "run", type: "oom", version: "1", input: { destination: destinationUrl, oom: true } });
    const started = Date.now();
    const deadline = started + 25000;
    while (owner.get("run").status === "running" && Date.now() < deadline) { owner.tick(); await worker.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(Date.now() - started).toBeLessThan(10000); // It must be killed before the 20-second wall-time budget.
    expect(owner.get("run").status).toBe("failed");
    expect(owner.get("run").outcome).toMatchObject({ ok: false, error: { code: "WorkflowFailed" } });
    const command = owner.inspect("run").commands[0];
    expect(command.outcome).toMatchObject({ ok: false, error: { code: "ActivityFailed" } });
    expect(command.attempts).toHaveLength(1);
    expect(command.attempts[0].outcome).toMatchObject({ ok: false, error: { code: "ActivityFailed" } });
    expect(oomEventsPath).toBeDefined();
    expect(oomKills(oomEventsPath!)).toBeGreaterThan(previousOomKills);
  } finally { await worker.drain(1000); await executor.close(); owner.close(); destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}, 60000);
