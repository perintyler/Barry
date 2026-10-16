import { afterAll, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeClosureInstallation, groupExists, workflowAgentClosure } from "../../test/fixtures/workflow-agent-closure.js";

afterAll(closeClosureInstallation);
type Fixture = Awaited<ReturnType<typeof workflowAgentClosure>>;
async function using(options: Parameters<typeof workflowAgentClosure>[0], run: (fixture: Fixture) => Promise<void>, expectUnsettled = false) {
  const f = await workflowAgentClosure(options), failures: unknown[] = [];
  try { await run(f); } catch (error) { failures.push(error); }
  try { await f.close({ preserve: failures.length > 0, expectUnsettled }); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual retained Pi fixture failed; preserved " + f.root);
}
function assertRetainedNative(f: Fixture) {
  expect(f.requests.length).toBeGreaterThan(0);
  for (const request of f.requests) {
    const mapping = f.backend.destination.inspect(f.key)!;
    const fence = f.backend.destination.settlements(mapping.turnId).find(row => (row.handle as { pid: number })?.pid === request.handle.pid)!;
    const outcome = f.outcomes().find(entry => entry.binding.segmentId === fence.segmentId)!;
    const runtime = join(outcome.directory, "runtime", "runtime", "node");
    expect(request.group.find(row => row.pid === request.handle.pid)?.command).toContain(runtime + " ");
    const application = request.group.find(row => row.pid !== request.handle.pid && row.command.includes(join(outcome.directory, "runtime", "worker.mjs")));
    expect(application).toBeDefined();expect(application!.command).toContain(runtime + " ");
    expect(application!.command).toContain(join(outcome.directory, "runtime", "guard.mjs"));
    expect(application!.command).not.toContain("tsx");expect(application!.command).not.toContain(f.installedPath);
    expect(request.authorization).toBe("Bearer retained-local-key");
    expect(fence.phase).toBe("ceased");expect(groupExists(request.handle.pgid)).toBe(false);
  }
  expect(f.providerErrors).toEqual([]);
}

const darwinIt = it.skipIf(process.platform !== "darwin");

darwinIt("cold launches the real retained Sessions worker and Pi graph after the entire installed generation and Node are deleted", async () => {
  await using({ mode: "plain", mutateCallerOptions: true }, async f => {
    expect(f.launches).toHaveLength(0);expect(f.configured).toHaveLength(0);
    f.removeInstalled();expect(existsSync(f.installedPath)).toBe(false);
    expect(await f.start()).toBe(f.result);assertRetainedNative(f);
    expect(f.requests).toHaveLength(1);expect(f.configured).toHaveLength(1);expect(f.callerMutations).toBe(1);
    expect(f.outcomes().map(entry => entry.outcome?.type)).toEqual(["completed"]);
    expect(await f.start()).toBe(f.result);f.reopen();expect(await f.start()).toBe(f.result);
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(1);
    expect(existsSync(join(f.root, "installed-tripwire"))).toBe(false);
  });
}, 180000);

darwinIt("resumes an actual Pi write checkpoint in a fresh retained native segment after installed adapter dependencies and runtime replacement", async () => {
  await using({ mode: "tool", mutateAfterCheckpoint: true }, async f => {
    expect(await f.start()).toBe(f.result);expect(f.checkpointMutations).toBe(1);
    expect(existsSync(join(f.root, "installed-tripwire"))).toBe(false);
    expect(readFileSync(join(f.root, "native-effect.txt"), "utf8")).toBe(f.content);
    const effect = statSync(join(f.root, "native-effect.txt"));
    expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(2);expect(f.configured).toHaveLength(2);
    expect(new Set(f.requests.map(request => request.handle.pid)).size).toBe(2);
    const second = f.requests[1].body as { messages: { role: string; tool_call_id?: string }[] };
    expect(second.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual([f.callId]);
    expect(f.db.prepare("SELECT call_id,state FROM session_call_outcomes").all()).toEqual([{ call_id: f.callId, state: "completed" }]);
    expect(f.db.prepare("SELECT state FROM session_run_segments ORDER BY rowid").all()).toEqual([{ state: "interrupted" }, { state: "completed" }]);
    expect(f.outcomes().map(entry => entry.outcome?.type).sort()).toEqual(["completed", "interrupted"]);assertRetainedNative(f);
    f.reopen();expect(await f.start()).toBe(f.result);expect(f.requests).toHaveLength(2);expect(f.launches).toHaveLength(2);
    expect(statSync(join(f.root, "native-effect.txt")).mtimeMs).toBe(effect.mtimeMs);
  });
}, 180000);

darwinIt("refuses altered retained adapter bytes before configure credentials input or a provider request without inventing a physical receipt", async () => {
  await using({ mode: "plain" }, async f => {
    f.removeInstalled();f.corruptAdapter();await expect(f.start()).rejects.toThrow();
    expect(f.configured).toHaveLength(0);expect(f.requests).toHaveLength(0);
    expect(f.db.prepare("SELECT phase,handle_json,input_at,ceased_at FROM session_workflow_settlements").all()).toEqual([{ phase: "not_started", handle_json: null, input_at: null, ceased_at: expect.any(String) }]);
    expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_preparation_refusals").get()).toEqual({ n: 1 });
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
    // Preparation rejects before returning a native handle; the pre-native
    // refusal is recorded without forging a physical process receipt.
  });
}, 180000);

darwinIt("keeps the accepted runtime identity across real SQLite reconstruction and refuses a different selected closure before traffic", async () => {
  await using({ mode: "plain" }, async f => {
    f.removeInstalled();expect(await f.start()).toBe(f.result);assertRetainedNative(f);
    const original = f.backend.destination.lookupSession(f.declaration.sessionId)!;
    expect(original.selection.runtime).toEqual(f.reference);
    f.reopen({ ...f.reference, digest: "0".repeat(64) });await expect(f.start()).rejects.toThrow();
    expect(f.requests).toHaveLength(1);expect(f.launches).toHaveLength(1);
    f.reopen();expect(await f.start()).toBe(f.result);expect(f.requests).toHaveLength(1);
    expect(f.backend.destination.lookupSession(f.declaration.sessionId)!.selection.runtime).toEqual(f.reference);
  });
}, 180000);


for (const adapterSelection of ["non-durable", "malformed-open"] as const) {
  darwinIt(`rejects actual retained Pi adapter selection with ${adapterSelection} before configure or credential release`, async () => {
    await using({ mode: "plain", adapterSelection }, async f => {
      f.removeInstalled();await expect(f.start()).rejects.toThrow();
      expect(f.configured).toHaveLength(0);expect(f.requests).toHaveLength(0);
      const mapping = f.backend.destination.inspect(f.key)!;
      const fences = f.backend.destination.settlements(mapping.turnId);
      expect(fences).toHaveLength(1);expect(fences[0]).toMatchObject({ phase: "ceased", inputAt: null });
      expect(groupExists((fences[0].handle as { pgid: number }).pgid)).toBe(false);
      expect(f.outcomes().map(entry => entry.outcome)).toEqual([undefined]);
      expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
    });
  }, 180000);
}

darwinIt("rechecks authority after a real retained adapter top-level await before configure credentials or model input", async () => {
  await using({ mode: "plain", adapterSelection: "blocked" }, async f => {
    f.removeInstalled();const operation = f.start().then(() => null, error => error);
    await expect.poll(() => existsSync(join(f.root, "selection-wait")), { timeout: 20000 }).toBe(true);
    expect(f.configured).toHaveLength(0);expect(f.requests).toHaveLength(0);
    const waiting = f.backend.destination.unsettled();
    expect(waiting).toMatchObject([{ phase: "handled", inputAt: null }]);
    const pgid = (waiting[0].handle as { pgid: number }).pgid;expect(groupExists(pgid)).toBe(true);
    f.revoke();f.releaseSelect();expect(await operation).toBeInstanceOf(Error);
    expect(f.configured).toHaveLength(0);expect(f.requests).toHaveLength(0);
    expect(f.backend.destination.unsettled()).toEqual([]);expect(groupExists(pgid)).toBe(false);
    expect(f.outcomes().map(entry => entry.outcome)).toEqual([undefined]);
    expect(existsSync(join(f.root, "native-effect.txt"))).toBe(false);
  });
}, 180000);
