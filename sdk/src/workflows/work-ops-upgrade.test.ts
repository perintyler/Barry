/** Historical v4 DDL copied verbatim from 8542c1dbfb738a5168697b9d3dccdfd719f6be3c; valid cancelled and unknown rows.
 * This verifies schema/receipt/custody compatibility, not native upgrade acceptance. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import { executionBindingSchema, executorObservationSchema, workReceiptSchema } from "./work-contracts.js";

const historicalV4 = `BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS executor_meta(installation TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS executions(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,
            binding TEXT NOT NULL,request TEXT,observation TEXT NOT NULL,fence INTEGER NOT NULL,
            PRIMARY KEY(owner,workflow,activity));
          CREATE TABLE IF NOT EXISTS execution_stages(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,stage TEXT NOT NULL,
            effect_key TEXT NOT NULL,intent_at INTEGER NOT NULL,handle TEXT,receipt TEXT,
            PRIMARY KEY(owner,workflow,activity,stage));
          CREATE TABLE IF NOT EXISTS execution_receipts(
            receipt_ref TEXT PRIMARY KEY,owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,
            revision INTEGER NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,
            UNIQUE(owner,workflow,activity,revision));
          CREATE TABLE IF NOT EXISTS execution_late_evidence(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,digest TEXT NOT NULL,
            receipt TEXT NOT NULL,observed_at INTEGER NOT NULL,current_fence INTEGER NOT NULL,
            PRIMARY KEY(owner,workflow,activity,digest));
          CREATE TABLE IF NOT EXISTS execution_stage_outputs(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,stage TEXT NOT NULL,
            reference TEXT NOT NULL,PRIMARY KEY(owner,workflow,activity,stage));
          CREATE TRIGGER IF NOT EXISTS execution_stage_output_immutable BEFORE UPDATE ON execution_stage_outputs
            BEGIN SELECT RAISE(ABORT,'stage output is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_binding_immutable BEFORE UPDATE OF binding ON executions
            BEGIN SELECT RAISE(ABORT,'execution binding is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_request_immutable BEFORE UPDATE OF request ON executions
            WHEN OLD.request IS NOT NULL BEGIN SELECT RAISE(ABORT,'execution request is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_receipt_immutable BEFORE UPDATE ON execution_receipts
            BEGIN SELECT RAISE(ABORT,'execution receipt is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_stage_receipt_immutable BEFORE UPDATE OF receipt ON execution_stages
            WHEN OLD.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'stage receipt is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_late_evidence_immutable BEFORE UPDATE ON execution_late_evidence
            BEGIN SELECT RAISE(ABORT,'late executor evidence is immutable'); END;
          CREATE UNIQUE INDEX IF NOT EXISTS execution_attempt_binding ON executions(owner,workflow,json_extract(binding,'$.activity_id'),json_extract(binding,'$.attempt_id'));
          PRAGMA user_version=4; COMMIT;`;

it("upgrades populated historical v4 bytes preserving valid pending receipt and unknown custody without new input", () => {
  const root = mkdtempSync(join(tmpdir(), "work-ops-v4-")), path = join(root, "executor.db");
  let journal: ExecutorJournal | undefined;
  try {
    const binding = executionBindingSchema.parse({ version: 2, owner: "owner", work_id: "work", workflow_id: "workflow", activity_id: "cancelled", attempt_id: "attempt",
      request_hash: "a".repeat(64), plan_digest: "b".repeat(64), grant_ref: "grant", grant_revision: 1, execution_fence: 1, deadline: 2_000_000,
      source: { digest: "c".repeat(64), bytes: 20, media_type: "text/javascript", owner_identity: null, purpose: "source" } });
    const observation = executorObservationSchema.parse({ ...binding, revision: 2, observed_at: 1_000_000, stage: "terminal", physical_state: "not-started",
      effect_certainty: "not-started", cancel_requested: true, reason: null, receipt_ref: "retained-receipt", handle: null });
    const unsigned = { ...binding, receipt_ref: "retained-receipt", revision: 2, committed_at: 1_000_000, physical_state: "not-started" as const,
      effect_certainty: "not-started" as const, outcome: "cancelled" as const, stages: [], output: null, summary: "historical cancellation", validation: "skipped" as const, validation_failures: null };
    const receipt = workReceiptSchema.parse({ ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
    const unknown = { ...binding, activity_id: "unknown", attempt_id: "unknown-attempt" };
    const request = { ...unknown, inputs: "retained input", effect_policy: { class: "non-repeatable", max_attempts: 1 },
      resources: { executor: "process", lane: "unscheduled", logical_reservation: "logical", host_reservation: "physical", endpoint: null }, executor_generation: "v2" };
    const retained = executorObservationSchema.parse({ ...observation, ...unknown, stage: "launching", physical_state: "unknown", effect_certainty: "uncertain", receipt_ref: null,
      handle: { kind: "process", installation: "host", boot_identity: "old-boot", pid: 12345, start_identity: "historical-start" } });
    const old = new SqliteDatabase(path);
    try {
      old.exec(historicalV4);
      old.prepare("INSERT INTO executor_meta VALUES(?)").run("host");
      const insert = old.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?)");
      insert.run("owner", "workflow", "cancelled", JSON.stringify(binding), null, JSON.stringify(observation), 1);
      insert.run("owner", "workflow", "unknown", JSON.stringify(unknown), JSON.stringify(request), JSON.stringify(retained), 1);
      old.prepare("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?)").run(receipt.receipt_ref, "owner", "workflow", "cancelled", 2, receipt.receipt_digest, JSON.stringify(receipt));
      old.prepare("INSERT INTO execution_stages VALUES(?,?,?,?,?,?,?,?)").run("owner", "workflow", "unknown", "execution", "retained-effect-key", 999_999, JSON.stringify(retained.handle), null);
      expect(old.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    } finally { old.close(); }
    journal = new ExecutorJournal({ path, installation: "host", now: () => 1_000_000 });
    expect(journal.pendingDeliveryCount("owner")).toBe(1);
    expect(journal.nextDelivery("owner")?.receipt).toEqual(receipt);
    expect(journal.inspect(unknown)).toEqual(retained);
    expect(journal.occupiedCount("owner")).toBe(1);
    expect(journal.claimStage(unknown, "execution").launch).toBe(false);
    expect(journal.claimStage(binding, "execution").launch).toBe(false);
    journal.acknowledgeDelivery(binding, receipt.receipt_digest, "accepted");
    expect(journal.receipt(binding)).toEqual(receipt);
    expect(journal.pendingDeliveryCount("owner")).toBe(0);
  } finally { journal?.close(); rmSync(root, { recursive: true, force: true }); }
});
