import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import {
  executionBindingSchema,
  executorStartSchema,
  logicalStageEffectKey,
} from "./work-contracts.js";
import type { z } from "zod";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { WorkArtifactStore } from "./work-artifacts.js";

type Start = z.infer<typeof executorStartSchema>;
const roots: string[] = [],
  journals: ExecutorJournal[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "executor-journal-"));
  roots.push(root);
  let now = Date.now();
  const path = join(root, "executor.db"),
    artifacts = new WorkArtifactStore(join(root, "outputs")),
    options = { path, installation: "host", now: () => now, artifacts };
  const journal = new ExecutorJournal(options);
  journals.push(journal);
  const binding = executionBindingSchema.parse({
    version: 2,
    owner: "owner",
    work_id: "work",
    workflow_id: "workflow",
    activity_id: "activity",
    attempt_id: "attempt",
    request_hash: "a".repeat(64),
    plan_digest: "b".repeat(64),
    grant_ref: "grant",
    grant_revision: 1,
    execution_fence: 1,
    deadline: now + 60000,
    source: {
      digest: "c".repeat(64),
      bytes: 20,
      media_type: "text/javascript",
      owner_identity: null,
      purpose: "source",
    },
  });
  const request: Start = {
    ...binding,
    inputs: "hello",
    effect_policy: { class: "non-repeatable", max_attempts: 1 },
    resources: {
      executor: "process",
      lane: "unscheduled",
      logical_reservation: "logical",
      host_reservation: "physical",
      endpoint: null,
    },
    executor_generation: "v2",
  };
  const stage = {
    stage: "execution" as const,
    effect_key: logicalStageEffectKey("owner", "workflow", "activity", "execution"),
    attempt_id: "attempt",
    state: "passed" as const,
    started_at: now,
    completed_at: now + 1,
    result: null,
  };
  const handle = {
    kind: "process" as const,
    installation: "host",
    boot_identity: "boot",
    pid: 123,
    start_identity: "start",
  };
  const reopen = () => {
    journal.close();
    const replacement = new ExecutorJournal(options);
    journals.push(replacement);
    return replacement;
  };
  return {
    root,
    path,
    options,
    artifacts,
    journal,
    binding,
    request,
    stage,
    handle,
    reopen,
    advance: (ms: number) => {
      now += ms;
    },
    receipt: (outcome: "complete" | "cancelled" | "uncertain" | "failed" = "complete") => {
      const observed = journal.inspect(binding)!;
      const unsigned = {
        ...binding,
        receipt_ref: "receipt",
        revision: observed.revision + 1,
        committed_at: now,
        physical_state: observed.physical_state,
        effect_certainty: observed.effect_certainty,
        outcome,
        stages: journal.stageReceipts(binding),
        output: null,
        summary: "retained result",
        validation: "skipped" as const,
        validation_failures: null,
      };
      return { ...unsigned, receipt_digest: workReceiptDigest(unsigned) };
    },
  };
}
it("redelivers immutable intent and refuses any changed attempt, source, grant, deadline, inputs or policy", () => {
  const f = fixture(),
    first = f.journal.start(f.request);
  expect(f.journal.start(f.request)).toEqual(first);
  for (const patch of [
    { attempt_id: "other" },
    { deadline: f.binding.deadline + 1 },
    { grant_ref: "other" },
    { inputs: "changed" },
    { source: { ...f.binding.source, digest: "d".repeat(64) } },
    { effect_policy: { class: "pure" as const, max_attempts: 2, retry_budget_ms: 1000 } },
  ])
    expect(() => f.journal.start({ ...f.request, ...patch })).toThrow(/bind|redelivery/);
  expect(f.reopen().inspect(f.binding)).toEqual(first);
});
function failedRetry(f: ReturnType<typeof fixture>) {
  f.request.effect_policy = { class: "pure", max_attempts: 2, retry_budget_ms: 60000 };
  f.request.budget_deadline = f.binding.deadline;
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, { ...f.stage, state: "failed" }, "ceased");
  const { receipt_digest: _digest, ...unsigned } = f.receipt("failed");
  const body = { ...unsigned, failure: { code: "Transient", retryable: true } };
  const receipt = f.journal.commitReceipt(f.binding, {
    ...body,
    receipt_digest: workReceiptDigest(body),
  });
  return {
    ...f.request,
    attempt_id: "attempt-2",
    execution_fence: 2,
    retry_from: {
      attempt_id: receipt.attempt_id,
      receipt_digest: receipt.receipt_digest,
      attempt_number: 2,
      retry_deadline: f.binding.deadline,
    },
  };
}
it("retains both physical attempts and stable logical stage keys for a proved bounded retry", () => {
  const f = fixture(),
    second = failedRetry(f);
  f.advance(10);
  const journal = f.reopen(),
    binding = executionBindingSchema.parse(
      Object.fromEntries(
        Object.keys(executionBindingSchema.shape).map((key) => [
          key,
          second[key as keyof typeof second],
        ]),
      ),
    );
  const first = journal.start(second);
  expect(journal.start(second)).toEqual(first);
  expect(journal.receipt(f.binding)?.outcome).toBe("failed");
  const claim = journal.claimStage(binding, "execution");
  expect(claim.launch).toBe(true);
  journal.completeStage(
    binding,
    {
      ...f.stage,
      attempt_id: binding.attempt_id,
      started_at: claim.observation.observed_at,
      completed_at: claim.observation.observed_at + 1,
    },
    "ceased",
  );
  const result = journal.publishRetainedResult(binding, {
    summary: "second succeeded",
    validation: "skipped",
    validation_failures: null,
  });
  expect(result.stages[0].effect_key).toBe(f.stage.effect_key);
  expect(journal.receipt(f.binding)?.outcome).toBe("failed");
  expect(journal.receipt(binding)?.outcome).toBe("complete");
  expect(() => journal.start({ ...second, attempt_id: "third", execution_fence: 3 })).toThrow(
    /policy|budget/,
  );
});
it("refuses changed retry proof, widened budget, changed inputs and retry over an active/uncertain attempt", () => {
  const f = fixture(),
    second = failedRetry(f);
  for (const patch of [
    { retry_from: undefined },
    { deadline: f.binding.deadline + 1 },
    { inputs: "different" },
    { retry_from: { ...second.retry_from, receipt_digest: "f".repeat(64) } },
    { retry_from: { ...second.retry_from, retry_deadline: f.binding.deadline + 1 } },
  ])
    expect(() => f.journal.start({ ...second, ...patch })).toThrow();
  const active = fixture();
  active.request.effect_policy = { class: "pure", max_attempts: 2, retry_budget_ms: 60000 };
  active.journal.start(active.request);
  active.journal.claimStage(active.binding, "execution");
  expect(() =>
    active.journal.start({
      ...active.request,
      attempt_id: "new",
      execution_fence: 2,
      retry_from: second.retry_from,
    }),
  ).toThrow();
  f.advance(60000);
  expect(() => f.journal.start(second)).toThrow(/deadline|budget|bounded/);
});
it("cancel-before-start durably tombstones a late start and never grants a stage launch", () => {
  const f = fixture(),
    stopped = f.journal.cancel(f.binding),
    recovered = f.reopen();
  expect(recovered.start(f.request)).toEqual(stopped);
  expect(recovered.claimStage(f.binding, "execution").launch).toBe(false);
  expect(stopped.physical_state).toBe("not-started");
});
it("guards every effectful stage separately and refuses replay after loss of launch identity", () => {
  const f = fixture();
  f.journal.start(f.request);
  expect(f.journal.claimStage(f.binding, "preflight").launch).toBe(true);
  expect(f.journal.inspect(f.binding)).toMatchObject({
    physical_state: "unknown",
    effect_certainty: "uncertain",
  });
  const recovered = f.reopen();
  expect(recovered.claimStage(f.binding, "preflight").launch).toBe(false);
  expect(() => recovered.claimStage(f.binding, "execution")).toThrow(/earlier stage/);
});
it("retains physical occupancy through cancellation and fencing and accepts no stale mutations", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.recordHandle(f.binding, "execution", f.handle);
  expect(f.journal.cancel(f.binding)).toMatchObject({
    physical_state: "stopping",
    cancel_requested: true,
  });
  f.journal.fence(f.binding, 2);
  expect(f.journal.inspect(f.binding)?.physical_state).toBe("stopping");
  expect(() => f.journal.claimStage(f.binding, "execution")).toThrow(/fenced/);
  expect(() => f.journal.completeStage(f.binding, f.stage, "ceased")).toThrow(/fenced/);
  expect(f.reopen().inspect(f.binding)?.physical_state).toBe("stopping");
});
it("retains immutable receipt and output evidence across completion acknowledgement loss", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.recordHandle(f.binding, "execution", f.handle);
  f.journal.completeStage(f.binding, f.stage, "ceased");
  const receipt = f.receipt();
  expect(f.journal.commitReceipt(f.binding, receipt)).toEqual(receipt);
  const recovered = f.reopen();
  expect(recovered.commitReceipt(f.binding, receipt)).toEqual(receipt);
  expect(recovered.receipt(f.binding)).toEqual(receipt);
  expect(recovered.cancel(f.binding).cancel_requested).toBe(false);
  expect(recovered.claimStage(f.binding, "execution").launch).toBe(false);
  const { receipt_digest: _digest, ...altered } = { ...receipt, summary: "replacement" };
  expect(() =>
    recovered.commitReceipt(f.binding, { ...altered, receipt_digest: workReceiptDigest(altered) }),
  ).toThrow(/immutable/);
});
it("serializes cancel versus completion while preserving the actual stage result", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.cancel(f.binding);
  f.journal.completeStage(f.binding, f.stage, "ceased");
  expect(() => f.journal.commitReceipt(f.binding, f.receipt())).toThrow(/Stop intent/);
  expect(f.journal.commitReceipt(f.binding, f.receipt("cancelled")).stages).toEqual([f.stage]);
});
it("preserves absolute deadlines and allows publication of already retained output after expiry", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, f.stage, "ceased");
  f.advance(60001);
  expect(f.journal.start(f.request).deadline).toBe(f.binding.deadline);
  expect(() => f.journal.claimStage(f.binding, "validation")).toThrow(/deadline/);
  expect(() => f.journal.claimStage(f.binding, "publication")).toThrow(/atomic retained-result/);
  expect(
    f.journal.publishRetainedResult(f.binding, {
      summary: "published retained result",
      validation: "skipped",
      validation_failures: null,
    }).outcome,
  ).toBe("complete");
});
it.each([true, false])(
  "recovers retained-result publication COMMIT ambiguity without another stage launch (applied: %s)",
  (applied) => {
    const f = fixture();
    f.journal.start(f.request);
    f.journal.claimStage(f.binding, "execution");
    const output = f.artifacts.stage(Buffer.from('"retained"'), {
      owner_identity: null,
      purpose: "output",
      media_type: "application/json",
    });
    f.journal.completeStage(f.binding, { ...f.stage, result: output }, "ceased");
    f.advance(60001);
    const metadata = {
      summary: "retained publication",
      validation: "skipped" as const,
      validation_failures: null,
    };
    const db = Reflect.get(f.journal, "db") as SqliteDatabase,
      original = db.exec.bind(db);
    vi.spyOn(db, "exec")
      .mockImplementationOnce((sql) => original(sql))
      .mockImplementationOnce((sql) => {
        if (sql === "COMMIT") {
          if (applied) original(sql);
          throw new Error("lost publication acknowledgement");
        }
        return original(sql);
      });
    expect(() => f.journal.publishRetainedResult(f.binding, metadata)).toThrow(/acknowledgement/);
    const receipt = f.journal.publishRetainedResult(f.binding, metadata);
    f.advance(1000);
    expect(f.journal.publishRetainedResult(f.binding, metadata)).toEqual(receipt);
    expect(receipt.output).toEqual(output);
    expect(f.artifacts.verify(receipt.output!).toString()).toBe('"retained"');
    expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
    expect(() =>
      f.journal.publishRetainedResult(f.binding, { ...metadata, summary: "different" }),
    ).toThrow(/immutable/);
  },
);
it("preserves retained main output on failed validation and cancellation before publication", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  const output = f.artifacts.stage(Buffer.from('"main output"'), {
    owner_identity: null,
    purpose: "output",
    media_type: "application/json",
  });
  f.journal.completeStage(f.binding, { ...f.stage, result: output }, "ceased");
  f.journal.claimStage(f.binding, "validation");
  f.journal.completeStage(
    f.binding,
    {
      ...f.stage,
      stage: "validation",
      effect_key: logicalStageEffectKey("owner", "workflow", "activity", "validation"),
      state: "failed",
    },
    "ceased",
  );
  f.advance(60001);
  expect(() =>
    f.journal.publishRetainedResult(f.binding, {
      summary: "cannot skip failure",
      validation: "skipped",
      validation_failures: null,
    }),
  ).toThrow(/validation verdict/);
  const metadata = {
    summary: "validation failure",
    validation: "failed" as const,
    validation_failures: ["schema rejected"],
  };
  const receipt = f.journal.publishRetainedResult(f.binding, metadata);
  expect(receipt.outcome).toBe("failed");
  expect(receipt.output).toEqual(output);
  const cancelled = fixture();
  cancelled.journal.start(cancelled.request);
  cancelled.journal.claimStage(cancelled.binding, "execution");
  cancelled.journal.completeStage(cancelled.binding, cancelled.stage, "ceased");
  cancelled.journal.cancel(cancelled.binding);
  cancelled.advance(60001);
  expect(
    cancelled.journal.publishRetainedResult(cancelled.binding, {
      summary: "stopped before publication",
      validation: "skipped",
      validation_failures: null,
    }).outcome,
  ).toBe("cancelled");
});
it("refuses publication over incomplete validation, missing artifacts, late effectful completion or stale fencing", () => {
  const metadata = {
    summary: "known result",
    validation: "skipped" as const,
    validation_failures: null,
  };
  const unresolved = fixture();
  unresolved.journal.start(unresolved.request);
  unresolved.journal.claimStage(unresolved.binding, "execution");
  unresolved.journal.completeStage(unresolved.binding, unresolved.stage, "ceased");
  unresolved.journal.claimStage(unresolved.binding, "validation");
  unresolved.advance(60001);
  expect(() => unresolved.journal.publishRetainedResult(unresolved.binding, metadata)).toThrow(
    /known main result|unresolved/,
  );
  const missing = fixture();
  missing.journal.start(missing.request);
  missing.journal.claimStage(missing.binding, "execution");
  const output = missing.artifacts.stage(Buffer.from('"lost"'), {
    owner_identity: null,
    purpose: "output",
    media_type: "application/json",
  });
  missing.journal.completeStage(missing.binding, { ...missing.stage, result: output }, "ceased");
  rmSync(missing.artifacts.path(output));
  rmSync(join(missing.artifacts.root, ".executor-retained"), { recursive: true, force: true });
  missing.advance(60001);
  expect(() => missing.journal.publishRetainedResult(missing.binding, metadata)).toThrow();
  expect(missing.journal.receipt(missing.binding)).toBeNull();
  const late = fixture();
  late.journal.start(late.request);
  late.journal.claimStage(late.binding, "execution");
  late.journal.completeStage(
    late.binding,
    { ...late.stage, completed_at: late.binding.deadline + 1 },
    "ceased",
  );
  late.advance(60002);
  expect(() => late.journal.publishRetainedResult(late.binding, metadata)).toThrow(
    /execution deadline/,
  );
  expect(() => late.journal.commitReceipt(late.binding, late.receipt())).toThrow(
    /original execution deadline/,
  );
  const fenced = fixture();
  fenced.journal.start(fenced.request);
  fenced.journal.claimStage(fenced.binding, "execution");
  fenced.journal.completeStage(fenced.binding, fenced.stage, "ceased");
  fenced.journal.fence(fenced.binding, 2);
  expect(() => fenced.journal.publishRetainedResult(fenced.binding, metadata)).toThrow(/fenced/);
});
it("rejects publication metadata overrides and preserves cessation when validation is explicitly skipped", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, f.stage, "ceased");
  f.journal.claimStage(f.binding, "validation");
  f.journal.completeStage(
    f.binding,
    {
      ...f.stage,
      stage: "validation",
      state: "skipped",
      effect_key: logicalStageEffectKey("owner", "workflow", "activity", "validation"),
    },
    "not-started",
  );
  f.advance(60001);
  const metadata = {
    summary: "skipped validation",
    validation: "skipped" as const,
    validation_failures: null,
  };
  expect(() =>
    f.journal.publishRetainedResult(f.binding, { ...metadata, output: null } as typeof metadata),
  ).toThrow(/Unrecognized key/);
  const receipt = f.journal.publishRetainedResult(f.binding, metadata);
  expect(receipt.physical_state).toBe("ceased");
  expect(receipt.outcome).toBe("complete");
});
it("keeps older retained receipts inspectable while refusing newly published completion outside its deadline", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(
    f.binding,
    { ...f.stage, completed_at: f.binding.deadline + 1 },
    "ceased",
  );
  const legacy = f.receipt(),
    db = Reflect.get(f.journal, "db") as SqliteDatabase;
  // A v1 journal written by the older contract; no current writer is allowed to create this verdict.
  db.prepare("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?)").run(
    legacy.receipt_ref,
    legacy.owner,
    legacy.workflow_id,
    legacy.activity_id,
    legacy.revision,
    legacy.receipt_digest,
    JSON.stringify(legacy),
  );
  const recovered = f.reopen();
  expect(recovered.receipt(f.binding)).toEqual(legacy);
  expect(() => recovered.commitReceipt(f.binding, legacy)).toThrow(/original execution deadline/);
});
it.each(["before", "after"])(
  "recovers a real publication writer killed %s commit without repeating a completed marker effect",
  async (boundary) => {
    const f = fixture(),
      marker = join(f.root, "marker.txt");
    f.journal.start(f.request);
    expect(f.journal.claimStage(f.binding, "execution").launch).toBe(true);
    const effect = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-write=${marker}`,
        "--eval",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'once\\n')`,
      ],
      { stdio: "ignore", env: {} },
    );
    children.push(effect);
    await once(effect, "spawn");
    await once(effect, "close");
    expect(effect.exitCode).toBe(0);
    const output = f.artifacts.stage(readFileSync(marker), {
      owner_identity: null,
      purpose: "output",
      media_type: "text/plain",
    });
    f.journal.completeStage(f.binding, { ...f.stage, result: output }, "ceased");
    f.advance(60001);
    const metadata = {
      summary: "real publication recovery",
      validation: "skipped" as const,
      validation_failures: null,
    };
    const module = new URL("../../dist/workflows/executor-journal.js", import.meta.url).href,
      artifactsModule = new URL("../../dist/workflows/work-artifacts.js", import.meta.url).href;
    const script = `
    import { ExecutorJournal } from ${JSON.stringify(module)};
    import { WorkArtifactStore } from ${JSON.stringify(artifactsModule)};
    const journal = new ExecutorJournal({path: ${JSON.stringify(f.path)}, installation: 'host', now: () => ${f.binding.deadline + 1}, artifacts: new WorkArtifactStore(${JSON.stringify(join(f.root, "outputs"))})});
    ${boundary === "after" ? `journal.publishRetainedResult(${JSON.stringify(f.binding)}, ${JSON.stringify(metadata)});` : ""}
    process.stdout.write('ready'); setInterval(() => {}, 1000);
  `;
    const writer = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    children.push(writer);
    await once(writer.stdout, "data");
    const stopped = once(writer, "close");
    writer.kill("SIGKILL");
    await stopped;
    const recovered = f.reopen(),
      receipt = recovered.publishRetainedResult(f.binding, metadata);
    expect(receipt.output).toEqual(output);
    expect(receipt.committed_at).toBeGreaterThan(f.binding.deadline);
    expect(recovered.publishRetainedResult(f.binding, metadata)).toEqual(receipt);
    expect(recovered.claimStage(f.binding, "execution").launch).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("once\n");
  },
);
it("rejects malformed handles and receipts and does not turn disappearance into a result", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  expect(() =>
    f.journal.recordHandle(f.binding, "execution", { ...f.handle, installation: "other" }),
  ).toThrow(/installation/);
  f.journal.recordHandle(f.binding, "execution", f.handle);
  expect(f.journal.receipt(f.binding)).toBeNull();
  expect(f.reopen().inspect(f.binding)).toMatchObject({
    physical_state: "running",
    handle: f.handle,
  });
  expect(() =>
    f.journal.completeStage(f.binding, { ...f.stage, attempt_id: "other" }, "ceased"),
  ).toThrow(/binding/);
});
it("cannot hide unknown earlier effects behind a later successful validation", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, { ...f.stage, state: "unknown" }, "ceased");
  expect(() => f.journal.claimStage(f.binding, "validation")).toThrow(/uncertain effects/);
  expect(() =>
    f.journal.publishRetainedResult(f.binding, {
      summary: "cannot mask uncertainty",
      validation: "skipped",
      validation_failures: null,
    }),
  ).toThrow(/known main result/);
  expect(f.journal.inspect(f.binding)?.effect_certainty).toBe("uncertain");
  expect(f.journal.commitReceipt(f.binding, f.receipt("uncertain")).outcome).toBe("uncertain");
});
it("keeps fenced receipts as late evidence and allows a current owner to request stop", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  f.journal.recordHandle(f.binding, "execution", f.handle);
  f.journal.fence(f.binding, 2);
  expect(() => f.journal.cancel(f.binding)).toThrow(/fenced/);
  expect(f.journal.cancel(f.binding, 2).physical_state).toBe("stopping");
  const receipt = f.receipt("uncertain");
  expect(() => f.journal.commitReceipt(f.binding, receipt)).toThrow(/fenced/);
  f.journal.retainLateReceipt(f.binding, receipt);
  f.journal.retainLateReceipt(f.binding, receipt);
  expect(f.journal.receipt(f.binding)).toBeNull();
  expect(f.reopen().lateReceipts(f.binding)).toEqual([receipt]);
});
it("does not fabricate a completion without execution or replace a terminal uncertainty", () => {
  const f = fixture();
  f.journal.start(f.request);
  expect(() => f.journal.commitReceipt(f.binding, f.receipt())).toThrow(/successful execution/);
  f.journal.claimStage(f.binding, "execution");
  f.journal.commitReceipt(f.binding, f.receipt("uncertain"));
  expect(() => f.journal.completeStage(f.binding, f.stage, "ceased")).toThrow(/reconciliation/);
  expect(f.journal.cancel(f.binding).cancel_requested).toBe(true);
  expect(f.journal.inspect(f.binding)?.effect_certainty).toBe("uncertain");
});
it("requires verified durable output and preserves it without re-execution after journal failure", () => {
  const f = fixture();
  f.journal.start(f.request);
  f.journal.claimStage(f.binding, "execution");
  const output = f.artifacts.stage(Buffer.from("structured result"), {
    owner_identity: null,
    media_type: "application/json",
    purpose: "output",
  });
  expect(() =>
    f.journal.completeStage(
      f.binding,
      { ...f.stage, result: { ...output, digest: "f".repeat(64) } },
      "ceased",
    ),
  ).toThrow();
  const db = new SqliteDatabase(f.path);
  db.exec(
    "CREATE TRIGGER fail_stage BEFORE UPDATE OF receipt ON execution_stages BEGIN SELECT RAISE(ABORT,'injected stage failure'); END",
  );
  expect(() =>
    f.journal.completeStage(f.binding, { ...f.stage, result: output }, "ceased"),
  ).toThrow(/injected/);
  expect(f.artifacts.verify(output).toString()).toBe("structured result");
  expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
  db.exec("DROP TRIGGER fail_stage");
  db.close();
  f.journal.completeStage(f.binding, { ...f.stage, result: output }, "ceased");
  const { receipt_digest: _digest, ...unsigned } = { ...f.receipt(), output };
  const receipt = { ...unsigned, receipt_digest: workReceiptDigest(unsigned) };
  f.journal.commitReceipt(f.binding, receipt);
  expect(f.reopen().receipt(f.binding)?.output).toEqual(output);
});
it.each([true, false])(
  "recovers receipt commit ambiguity without repeating execution (commit applied: %s)",
  (applied) => {
    const f = fixture();
    f.journal.start(f.request);
    f.journal.claimStage(f.binding, "execution");
    f.journal.completeStage(f.binding, f.stage, "ceased");
    const receipt = f.receipt(),
      db = Reflect.get(f.journal, "db") as SqliteDatabase,
      original = db.exec.bind(db);
    vi.spyOn(db, "exec")
      .mockImplementationOnce((sql) => original(sql))
      .mockImplementationOnce((sql) => {
        if (sql === "COMMIT") {
          if (applied) original(sql);
          throw new Error("lost receipt acknowledgement");
        }
        return original(sql);
      });
    expect(() => f.journal.commitReceipt(f.binding, receipt)).toThrow(/acknowledgement/);
    expect(f.journal.receipt(f.binding)).toEqual(applied ? receipt : null);
    expect(f.journal.commitReceipt(f.binding, receipt)).toEqual(receipt);
    expect(f.journal.claimStage(f.binding, "execution").launch).toBe(false);
  },
);
it.each([true, false])(
  "reopens after an ambiguous launch-claim commit (commit applied: %s)",
  (applied) => {
    const f = fixture();
    f.journal.start(f.request);
    const db = Reflect.get(f.journal, "db") as SqliteDatabase,
      original = db.exec.bind(db);
    vi.spyOn(db, "exec")
      .mockImplementationOnce((sql) => original(sql))
      .mockImplementationOnce((sql) => {
        if (sql === "COMMIT") {
          if (applied) original(sql);
          throw new Error("lost commit acknowledgement");
        }
        return original(sql);
      });
    expect(() => f.journal.claimStage(f.binding, "execution")).toThrow(/acknowledgement/);
    expect(f.journal.claimStage(f.binding, "execution").launch).toBe(!applied);
  },
);
it("refuses wrong installation and future journal schema", () => {
  const f = fixture();
  f.journal.close();
  expect(() => new ExecutorJournal({ ...f.options, installation: "other" })).toThrow(
    /installation/,
  );
  const db = new SqliteDatabase(f.path);
  db.exec("PRAGMA user_version=999");
  db.close();
  expect(() => new ExecutorJournal(f.options)).toThrow(/version/);
});

// Exercise persisted launch evidence against actual process death. This is the
// journal guard, not qualification of a P3 process-supervisor adapter.
it.each(["intent", "launch", "effect", "receipt"])(
  "survives SIGKILL at the %s boundary without an unproven second effect",
  async (checkpoint) => {
    const f = fixture();
    f.journal.close();
    const marker = join(f.root, "effect-count"),
      journalUrl = new URL("./executor-journal.ts", import.meta.url).href;
    const code = `
    import { ExecutorJournal,workReceiptDigest } from ${JSON.stringify(journalUrl)};
    import { appendFileSync } from 'node:fs';
    const [options,request,binding,stage,marker,checkpoint] = JSON.parse(process.argv[1]);
    const journal = new ExecutorJournal(options);
    const stop = async where => { if(where === checkpoint) { process.send(where); await new Promise(resolve => process.once('message',resolve)); } };
    journal.start(request); await stop('intent');
    const claim = journal.claimStage(binding,'execution');
    if(!claim.launch) { process.send('suppressed'); journal.close(); process.exit(0); }
    await stop('launch');
    appendFileSync(marker,'effect\\n',{flush:true}); await stop('effect');
    journal.completeStage(binding,stage,'ceased');
    const observation=journal.inspect(binding);
    const unsigned={...binding,receipt_ref:'receipt',revision:observation.revision+1,committed_at:Date.now(),
      physical_state:'ceased',effect_certainty:'known',outcome:'complete',stages:journal.stageReceipts(binding),
      output:null,summary:'done',validation:'skipped',validation_failures:null};
    journal.commitReceipt(binding,{...unsigned,receipt_digest:workReceiptDigest(unsigned)});
    await stop('receipt'); journal.close(); process.send('done');
  `;
    const launch = (pause: string) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          code,
          JSON.stringify([
            { path: f.path, installation: "host" },
            f.request,
            f.binding,
            f.stage,
            marker,
            pause,
          ]),
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      children.push(child);
      return child;
    };
    const child = launch(checkpoint);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const first = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(stderr || "journal child exited before checkpoint");
      }),
    ]);
    expect(first[0]).toBe(checkpoint);
    if (checkpoint !== "intent") {
      const duplicate = launch("none"),
        duplicateExit = once(duplicate, "exit");
      expect((await once(duplicate, "message"))[0]).toBe("suppressed");
      await duplicateExit;
    }
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
    const recovered = f.reopen(),
      observed = recovered.inspect(f.binding)!;
    if (["launch", "effect"].includes(checkpoint))
      expect(observed.effect_certainty).toBe("uncertain");
    if (checkpoint === "receipt") expect(recovered.receipt(f.binding)?.outcome).toBe("complete");
    recovered.close();
    const restart = launch("none");
    const restartExit = once(restart, "exit");
    const response = await once(restart, "message");
    expect(response[0]).toBe(checkpoint === "intent" ? "done" : "suppressed");
    await restartExit;
    const count = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
    expect(count).toBe(checkpoint === "launch" ? 0 : 1);
    if (count) expect(readFileSync(marker, "utf8")).toBe("effect\n");
  },
  15000,
);
it.each([false, true])("keeps delivery acknowledgements digest-bound and durable through COMMIT (%s)", applied => {
  const f = fixture(); f.journal.start(f.request); const begun = f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, { ...f.stage, state: "passed", started_at: begun.observation.observed_at, completed_at: begun.observation.observed_at }, "ceased");
  const receipt = f.journal.publishRetainedResult(f.binding, { summary: "Delivery recovery", validation: "skipped", validation_failures: null });
  expect(f.journal.pendingDeliveryCount()).toBe(1);
  expect(() => f.journal.acknowledgeDelivery(f.binding, "0".repeat(64), "accepted")).toThrow(/differs/);
  const db = Reflect.get(f.journal, "db") as SqliteDatabase, original = db.exec.bind(db); let failed = false;
  vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT" && !failed) { failed = true; if (applied) original(sql); throw new Error("acknowledgement commit response lost"); } return original(sql); });
  expect(() => f.journal.acknowledgeDelivery(f.binding, receipt.receipt_digest, "accepted")).toThrow(/response lost/);
  const reopened = f.reopen(); expect(reopened.pendingDeliveryCount()).toBe(applied ? 0 : 1);
  reopened.acknowledgeDelivery(f.binding, receipt.receipt_digest, "alreadyAccepted"); expect(reopened.pendingDeliveryCount()).toBe(0);
});
it("visits healthy receipt delivery beyond a full failing batch and preserves progress on reopen", () => {
  const f = fixture(); f.journal.start(f.request); const begun = f.journal.claimStage(f.binding, "execution");
  f.journal.completeStage(f.binding, { ...f.stage, state: "passed", started_at: begun.observation.observed_at, completed_at: begun.observation.observed_at }, "ceased");
  const receipt = f.journal.publishRetainedResult(f.binding, { summary: "Fair delivery", validation: "skipped", validation_failures: null });
  const db = Reflect.get(f.journal, "db") as SqliteDatabase;
  f.journal.acknowledgeDelivery(f.binding, receipt.receipt_digest, "accepted");
  for (let index = 0; index < 65; index++) {
    const activity = `fair-${String(index).padStart(3, "0")}`, binding = { ...f.binding, activity_id: activity, attempt_id: `attempt-${index}` };
    const { receipt_digest: _old, ...unsigned } = { ...receipt, ...binding, receipt_ref: activity,
      stages: receipt.stages.map(stage => ({ ...stage, attempt_id: binding.attempt_id, effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, activity, stage.stage) })) };
    const observation = { ...f.journal.inspect(f.binding)!, ...binding, receipt_ref: activity };
    db.prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?)").run(binding.owner, binding.workflow_id, activity, JSON.stringify(binding), JSON.stringify({ ...f.request, ...binding }), JSON.stringify(observation), binding.execution_fence);
    db.prepare("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?)").run(activity, binding.owner, binding.workflow_id, activity, receipt.revision,
      workReceiptDigest(unsigned), JSON.stringify({ ...unsigned, receipt_digest: workReceiptDigest(unsigned) }));
    db.prepare("INSERT INTO execution_deliveries(receipt_ref) VALUES(?)").run(activity);
  }
  for (let index = 0; index < 64; index++) expect(f.journal.nextDelivery("owner")?.receipt.receipt_ref).not.toBe("fair-064");
  const recovered = f.reopen(); expect(recovered.nextDelivery("owner")?.receipt.receipt_ref).toBe("fair-064");
});

it("retains immutable stage logs before cessation and through journal reopen", () => {
  const f = fixture(); f.journal.start(f.request); f.journal.claimStage(f.binding, "execution"); f.journal.recordHandle(f.binding, "execution", f.handle);
  const log = f.artifacts.stage(Buffer.from('{"stderr":"durable diagnostic"}'), { owner_identity: null, purpose: "log", media_type: "application/json" });
  f.journal.retainStageOutput(f.binding, "execution", log, "log");
  expect(f.journal.inspect(f.binding)?.physical_state).toBe("running");
  const reopened = f.reopen(); expect(reopened.retainedStageOutput(f.binding, "execution", "log")).toEqual(log);
  rmSync(f.artifacts.path(log)); expect(f.artifacts.verify(log).toString()).toContain("durable diagnostic");
  const different = f.artifacts.stage(Buffer.from('{}'), { owner_identity: null, purpose: "log", media_type: "application/json" });
  expect(() => reopened.retainStageOutput(f.binding, "execution", different, "log")).toThrow(/cannot change/);
  expect(() => reopened.completeStage(f.binding, f.stage, "ceased")).toThrow(/retained stage log/);
  reopened.completeStage(f.binding, { ...f.stage, logs: log }, "ceased"); expect(reopened.stageReceipts(f.binding)[0]!.logs).toEqual(log);
});
