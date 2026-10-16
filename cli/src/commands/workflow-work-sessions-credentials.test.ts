import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workflowWorkSessions } from "../../test/fixtures/workflow-work-sessions.js";

it("refuses missing selected provider credentials without ambient fallback, new input or retained physical occupancy", async () => {
  const f = await workflowWorkSessions(), failures: unknown[] = [];
  try {
    // Managed services still have wrong-installation/ambient credential canaries.
    // Remove only the selected provider key, retaining the harness credential.
    const selected = join(f.root, "selected-secrets/.env");
    const remaining = readFileSync(selected, "utf8").split("\n").filter(line => !line.startsWith("OPENAI_API_KEY=")).join("\n");
    expect(remaining).toContain("ANTHROPIC_API_KEY=selected-harness-key");
    writeFileSync(selected, remaining, { mode: 0o600 });chmodSync(selected, 0o600);
    const work = await f.accept();
    await f.awaitReceipt(work.work_id);
    const receipt = f.receipt();
    expect(receipt.work_id).toBe(work.work_id);
    expect(["not-started", "ceased"]).toContain(receipt.physical_state);
    expect(receipt.outcome).not.toBe("complete");
    expect(f.requests).toEqual([]);expect(f.providerErrors).toEqual([]);
    const fences = f.fences();
    if (receipt.physical_state === "ceased") expect(fences.length).toBeGreaterThan(0);
    else expect(fences).toHaveLength(0);
    for (const fence of fences) {
      expect(fence.input_at).toBeNull();expect(fence.ceased_at).toEqual(expect.any(String));
      expect(["ceased", "not_started"]).toContain(fence.phase);
      if (fence.phase === "ceased") {
        const native = JSON.parse(fence.handle_json) as { pid: number; pgid: number };
        expect(Number.isSafeInteger(native.pid) && native.pid > 0).toBe(true);expect(native.pgid).toBe(native.pid);
        let absent = false;
        try { process.kill(-native.pgid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
        expect(absent).toBe(true);
      }
    }
    await expect.poll(() => f.reservations(), { timeout: 5000 }).toMatchObject({ host: [{ state: "released" }], endpoint: [{ state: "released" }] });
    // Current conservative mapping may retain an uncertain logical outcome even
    // after proven pre-input cessation. It must never publish successful work.
    expect((await f.result(work.work_id)).outcome?.ok).not.toBe(true);
    expect(f.ownerRows()).toHaveLength(1);
    const replay = await f.submit();expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ work_id: work.work_id, workflow_id: work.workflow_id, run_id: work.run_id, created: false });
    expect(f.requests).toEqual([]);expect(f.fences()).toEqual(fences);expect(f.ownerRows()).toHaveLength(1);
    expect(f.receipt().receipt_digest).toBe(receipt.receipt_digest);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual Work Sessions credential refusal failed; preserved " + f.root);
}, 180000);
