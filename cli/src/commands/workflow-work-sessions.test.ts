import { expect, it } from "vitest";
import { workflowWorkSessions } from "../../test/fixtures/workflow-work-sessions.js";

it("executes signed managed Work through retained Sessions Pi and recovers a lost admission reply across completed service restart", async () => {
  const f = await workflowWorkSessions(), failures: unknown[] = [];
  try {
    await f.loseAdmissionAcknowledgement();
    const recovered = await f.submit();expect(recovered.status, await recovered.clone().text()).toBe(200);
    const work = await recovered.json() as { work_id: string; workflow_id: string; run_id: string; created: boolean };
    expect(work.created).toBe(false);
    await f.awaitOutcome(work.work_id, true);
    expect((await f.result(work.work_id)).outcome).toEqual({ ok: true, value: { answer: 42 } });
    expect(f.requests).toHaveLength(1);expect(f.providerErrors).toEqual([]);
    expect(f.requests[0]).toMatchObject({ authorization: `Bearer ${f.selectedKey}`, fence: { phase: "input", input_at: expect.any(String) }, host: [{ state: "held" }], endpoint: [{ state: "held" }] });
    expect(f.receipt()).toMatchObject({ work_id: work.work_id, physical_state: "ceased", validation: "passed" });
    const fences = f.fences();expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ phase: "ceased", input_at: expect.any(String), ceased_at: expect.any(String) });
    const native = JSON.parse(fences[0]!.handle_json) as { pid: number; pgid: number };
    expect(native.pgid).toBe(native.pid);
    let absent = false;try { process.kill(-native.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
    expect(absent).toBe(true);
    await expect.poll(() => f.reservations(), { timeout: 5000 }).toMatchObject({ host: [{ state: "released" }], endpoint: [{ state: "released" }] });
    expect(f.ownerRows()).toHaveLength(1);
    const admission = JSON.parse(f.ownerRows()[0]!.record);
    expect(admission).toMatchObject({ namespace: { principal_kind: "identity", principal_id: f.identity, identity_id: f.identity, caller_session_id: "owned" },
      plan: { resources: { executor: "agent" }, agent_program: { installation: f.installation }, selection: { resolved_harness: "pi", resolved_model: "openai/probe" } } });
    expect(JSON.stringify(f.ownerRows())).not.toContain(f.selectedKey);
    expect(JSON.stringify(f.receipt())).not.toContain(f.selectedKey);
    const duplicate = await f.submit();expect(duplicate.status, await duplicate.clone().text()).toBe(200);
    expect(await duplicate.json()).toMatchObject({ work_id: work.work_id, workflow_id: work.workflow_id, run_id: work.run_id, created: false });
    expect(f.requests).toHaveLength(1);expect(f.ownerRows()).toHaveLength(1);expect(f.fences()).toHaveLength(1);
    await f.restartAfterCompletion();
    const replay = await f.submit();expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ work_id: work.work_id, workflow_id: work.workflow_id, run_id: work.run_id, created: false });
    expect((await f.result(work.work_id)).outcome).toEqual({ ok: true, value: { answer: 42 } });
    expect(f.requests).toHaveLength(1);expect(f.ownerRows()).toHaveLength(1);expect(f.fences()).toHaveLength(1);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual Work Sessions integration failed; preserved " + f.root);
}, 180000);

it("retains failed JSON validation and frees both brokers after actual agent cessation without another provider call", async () => {
  const f = await workflowWorkSessions({ providerOutput: "not JSON" }), failures: unknown[] = [];
  try {
    const work = await f.accept();
    await f.awaitReceipt(work.work_id, "failed");
    expect(f.receipt()).toMatchObject({ work_id: work.work_id, physical_state: "ceased", outcome: "failed", validation: "failed" });
    expect(f.receipt().validation_failures.length).toBeGreaterThan(0);
    expect(f.requests).toHaveLength(1);expect(f.providerErrors).toEqual([]);
    const fences = f.fences();expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ phase: "ceased", input_at: expect.any(String), ceased_at: expect.any(String) });
    const native = JSON.parse(fences[0]!.handle_json) as { pid: number; pgid: number };
    expect(native.pgid).toBe(native.pid);
    let absent = false;try { process.kill(-native.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
    expect(absent).toBe(true);
    await expect.poll(() => f.reservations(), { timeout: 5000 }).toMatchObject({ host: [{ state: "released" }], endpoint: [{ state: "released" }] });
    await expect.poll(async () => (await f.result(work.work_id)).outcome?.ok, { timeout: 5000 }).toBe(false);
    const replay = await f.submit();expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ work_id: work.work_id, workflow_id: work.workflow_id, run_id: work.run_id, created: false });
    expect(f.requests).toHaveLength(1);expect(f.fences()).toHaveLength(1);expect(f.ownerRows()).toHaveLength(1);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual Work Sessions validation failure failed; preserved " + f.root);
}, 180000);

it("stops actual Work-owned Pi during held provider input and releases both brokers only with native cessation", async () => {
  const f = await workflowWorkSessions({ holdProvider: true }), failures: unknown[] = [];
  try {
    const work = await f.accept();
    await f.awaitProviderInput(work.work_id);
    expect(f.providerErrors).toEqual([]);
    expect(f.requests[0]).toMatchObject({ authorization: `Bearer ${f.selectedKey}`, fence: { phase: "input" }, host: [{ state: "held" }], endpoint: [{ state: "held" }] });
    expect(f.receipt()).toBeUndefined();
    expect(f.reservations()).toMatchObject({ host: [{ state: "held" }], endpoint: [{ state: "held" }] });
    await f.stop(work.work_id);
    await expect.poll(() => f.receipt()?.physical_state, { timeout: 30000 }).toBe("ceased");
    const fences = f.fences();expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ phase: "ceased", input_at: expect.any(String), ceased_at: expect.any(String) });
    const native = JSON.parse(fences[0]!.handle_json) as { pid: number; pgid: number };
    expect(native.pgid).toBe(native.pid);
    let absent = false;try { process.kill(-native.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
    expect(absent).toBe(true);
    await expect.poll(() => f.reservations(), { timeout: 5000 }).toMatchObject({ host: [{ state: "released" }], endpoint: [{ state: "released" }] });
    expect((await f.result(work.work_id)).outcome).toMatchObject({ ok: false });
    const replay = await f.submit();expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ work_id: work.work_id, workflow_id: work.workflow_id, run_id: work.run_id, created: false });
    expect(f.requests).toHaveLength(1);expect(f.fences()).toHaveLength(1);expect(f.ownerRows()).toHaveLength(1);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual Work Sessions Stop failed; preserved " + f.root);
}, 180000);
