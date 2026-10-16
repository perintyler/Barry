/** Disposable real journal tests; no native process or provider is launched. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import { executionBindingSchema } from "./work-contracts.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "work-ops-recovery-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const options = { path: join(root, "executor.db"), installation: "original-host", now: () => 1_000_000 };
  const open = () => { const journal = new ExecutorJournal(options); cleanup.push(() => journal.close()); return journal; };
  const binding = executionBindingSchema.parse({ version: 2, owner: "owner", work_id: "work", workflow_id: "workflow", activity_id: "activity", attempt_id: "attempt",
    request_hash: "a".repeat(64), plan_digest: "b".repeat(64), grant_ref: "grant", grant_revision: 1, execution_fence: 1, deadline: 2_000_000,
    source: { digest: "c".repeat(64), bytes: 20, media_type: "text/javascript", owner_identity: null, purpose: "source" } });
  const request = { ...binding, inputs: "original", effect_policy: { class: "non-repeatable" as const, max_attempts: 1 },
    resources: { executor: "process" as const, lane: "unscheduled" as const, logical_reservation: "logical", host_reservation: "physical", endpoint: null }, executor_generation: "v2" };
  return { open, binding, request };
}

it("retains the same undelivered receipt across restart and ACK loss without another stage input", () => {
  const f = fixture(), first = f.open();
  const observation = first.cancel(f.binding); // Durable cancel-before-start: positively no launch.
  const unsigned = { ...f.binding, receipt_ref: "receipt", revision: observation.revision + 1, committed_at: 1_000_000,
    physical_state: observation.physical_state, effect_certainty: observation.effect_certainty, outcome: "cancelled" as const,
    stages: [], output: null, summary: "cancelled before launch", validation: "skipped" as const, validation_failures: null };
  const receipt = first.commitReceipt(f.binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  expect(first.nextDelivery("owner")?.receipt).toEqual(receipt); first.close();
  const restarted = f.open();
  expect(restarted.pendingDeliveryCount("owner")).toBe(1);
  expect(restarted.nextDelivery("owner")?.receipt).toEqual(receipt);
  expect(restarted.claimStage(f.binding, "execution").launch).toBe(false);
  restarted.acknowledgeDelivery(f.binding, receipt.receipt_digest, "accepted");
  restarted.acknowledgeDelivery(f.binding, receipt.receipt_digest, "alreadyAccepted");
  expect(restarted.pendingDeliveryCount("owner")).toBe(0);
  expect(restarted.receipt(f.binding)).toEqual(receipt);
});

it("preserves an unknown launch and its capacity after restart; stored boot/PID metadata cannot authorize another input", () => {
  const f = fixture(), first = f.open(); first.start(f.request);
  expect(first.claimStage(f.binding, "execution").launch).toBe(true);
  first.recordHandle(f.binding, "execution", { kind: "process", installation: "original-host", boot_identity: "old-boot", pid: 12345, start_identity: "retained-start" });
  first.close(); const restarted = f.open();
  restarted.markGuardianLost(f.binding);
  expect(restarted.inspect(f.binding)?.physical_state).toBe("unknown");
  expect(restarted.occupiedCount("owner")).toBe(1);
  expect(restarted.claimStage(f.binding, "execution").launch).toBe(false);
  expect(restarted.stageReceipts(f.binding)).toEqual([]);
  expect(restarted.receipt(f.binding)).toBeNull();
});
