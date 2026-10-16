import { expect, it } from "vitest";
import {
  workSubmissionSchema,
  workIntentHash,
  logicalStageEffectKey,
  projectWorkState,
  executorFeaturesSchema,
  workReceiptSchema,
  validateHumanDecisionResponse,
  type WorkNamespace,
  type WorkSubmission,
  type WorkStateFacts,
} from "./work-contracts.js";
const namespace: WorkNamespace = {
  installation: "owner",
  principal_kind: "identity",
  principal_id: "caller",
  identity_id: "caller",
  caller_session_id: "session",
};
const request: WorkSubmission = {
  version: 2,
  request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05437",
  idempotency_key: "invocation",
  authority_ref: "persisted-grant",
  definition: { kind: "action", reference: "review", catalog_namespace: "caller" },
  inputs: { a: 1, b: 2 },
  origin: { entry_point: "action-run", trigger: "invocation", caller_session_id: "session" },
};
const facts: WorkStateFacts = {
  coordinator: "running",
  phase: "queued",
  wait: "none",
  physical: "not-started",
  effect: "not-started",
  stop_requested: false,
  has_result: false,
  can_continue: false,
  can_retry_step: false,
  can_respond: false,
};
it("binds intent to authority and substantive arguments while excluding the transport request ID", () => {
  const hash = workIntentHash(request, namespace);
  expect(
    workIntentHash(
      { ...request, request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438", inputs: { b: 2, a: 1 } },
      namespace,
    ),
  ).toBe(hash);
  expect(workIntentHash(request, { ...namespace, identity_id: "other" })).not.toBe(hash);
  expect(workIntentHash({ ...request, inputs: { a: 2, b: 2 } }, namespace)).not.toBe(hash);
  expect(workIntentHash({ ...request, overrides: { timeout_ms: 1000 } }, namespace)).not.toBe(hash);
  expect(workIntentHash({ ...request, overrides: { traits: ["b", "a", "b"] } }, namespace)).toBe(
    workIntentHash({ ...request, overrides: { traits: ["a", "b"] } }, namespace),
  );
  expect(workIntentHash({ ...request, inputs: [1, 2] }, namespace)).not.toBe(
    workIntentHash({ ...request, inputs: [2, 1] }, namespace),
  );
});
it.each(["action-run", "action-begin", "job-runs", "schedule", "event", "internal"])(
  "uses the shared envelope for %s without synthetic actions for jobs",
  (entry) => {
    const definition =
      entry === "job-runs" || entry === "internal"
        ? { kind: "job" as const, reference: "notes:summarize@1" }
        : request.definition;
    expect(
      workSubmissionSchema.parse({
        ...request,
        definition,
        origin: { ...request.origin, entry_point: entry },
      }).definition,
    ).toEqual(definition);
  },
);
it("refuses client-authored authority, unknown fields, oversized keys and non-JSON inputs", () => {
  expect(workSubmissionSchema.safeParse({ ...request, grant: {} }).success).toBe(false);
  expect(
    workSubmissionSchema.safeParse({ ...request, idempotency_key: "😀".repeat(51) }).success,
  ).toBe(false);
  expect(workSubmissionSchema.safeParse({ ...request, inputs: Infinity }).success).toBe(false);
  expect(workSubmissionSchema.safeParse({ ...request, inputs: "x".repeat(262144) }).success).toBe(
    false,
  );
});
it("keeps effect keys stable across attempts and separates stages and logical runs", () => {
  const key = logicalStageEffectKey("owner", "run", "activity", "execution");
  const attempts = [1, 2, 3].map((_attempt) =>
    logicalStageEffectKey("owner", "run", "activity", "execution"),
  );
  expect(new Set(attempts)).toEqual(new Set([key]));
  expect(logicalStageEffectKey("owner", "run", "activity", "validation")).not.toBe(key);
  expect(logicalStageEffectKey("owner", "run-again", "activity", "execution")).not.toBe(key);
});
it.each([
  [{}, "queued"],
  [{ phase: "executing", physical: "running" }, "running"],
  [{ phase: "executing", physical: "running", effect: "uncertain" }, "running"],
  [{ coordinator: "cancelled", stop_requested: true, physical: "running", effect: "uncertain" }, "stopping"],
  [{ coordinator: "blocked", physical: "running", effect: "uncertain" }, "needs-attention"],
  [{ physical: "unknown", effect: "uncertain" }, "needs-attention"],
  [{ wait: "signal" }, "waiting"],
  [{ wait: "human-decision" }, "waiting-for-approval"],
  [{ coordinator: "completed", physical: "ceased", effect: "known" }, "completed"],
  [{ coordinator: "cancelled", stop_requested: true, physical: "running" }, "stopping"],
  [{ coordinator: "cancelled", stop_requested: true, physical: "ceased" }, "cancelled"],
  [{ coordinator: "timed_out", physical: "unknown" }, "needs-attention"],
  [{ coordinator: "timed_out", physical: "ceased", effect: "known" }, "failed"],
  [{ coordinator: "completed", physical: "running" }, "needs-attention"],
  [{ coordinator: "failed", physical: "ceased", effect: "uncertain" }, "needs-attention"],
] as const)("projects state from structured facts: %j -> %s", (patch, state) => {
  expect(projectWorkState({ ...facts, ...patch }).state).toBe(state);
});
it("does not authorize retries or continuation of uncertain effects, or responses to generic signals", () => {
  const uncertain = projectWorkState({
    ...facts,
    coordinator: "blocked",
    physical: "ceased",
    effect: "uncertain",
    can_continue: true,
    can_retry_step: true,
    has_result: true,
  });
  expect(uncertain.allowed_actions).toEqual(["inspect", "result", "stop", "reconcile"]);
  expect(
    projectWorkState({ ...facts, wait: "signal", can_respond: true }).allowed_actions,
  ).not.toContain("respond");
  expect(projectWorkState({ ...facts, phase: "preflight" }).allowed_actions).toContain("stop");
});
it("verifies typed decision responder, revision, expiry and option before any receipt is accepted", () => {
  const decision = {
    version: 2 as const,
    decision_id: "approve",
    work_id: "work",
    revision: 1,
    prompt: "Approve publication?",
    options: [{ id: "yes", label: "Approve" }],
    allowed_responders: ["caller"],
    deadline: 100,
  };
  const response = {
    version: 2 as const,
    decision_id: "approve",
    expected_revision: 1,
    request_id: request.request_id,
    option_id: "yes",
  };
  expect(() => validateHumanDecisionResponse(decision, response, "caller", 99)).not.toThrow();
  expect(() => validateHumanDecisionResponse(decision, response, "other", 99)).toThrow(
    /unauthorized/,
  );
  expect(() => validateHumanDecisionResponse(decision, response, "caller", 100)).toThrow(/expired/);
  expect(() =>
    validateHumanDecisionResponse(decision, { ...response, expected_revision: 2 }, "caller", 99),
  ).toThrow(/revision/);
  expect(() =>
    validateHumanDecisionResponse(decision, { ...response, option_id: "invented" }, "caller", 99),
  ).toThrow(/not allowed/);
});
it("refuses immortal capability observations", () => {
  expect(
    executorFeaturesSchema.safeParse({
      version: 2,
      observed_at: 10,
      expires_at: 10,
      installation: "node",
      boot_identity: "boot",
      executors: ["process"],
      features: ["stop-ack"],
      runtimes: {},
      workspaces: [],
      containment: "portable",
    }).success,
  ).toBe(false);
});
it("refuses terminal success receipts before cessation or with mismatched logical effect keys", () => {
  const artifact = {
    digest: "a".repeat(64),
    bytes: 1,
    media_type: "text/plain",
    owner_identity: "caller",
    purpose: "source" as const,
  };
  const receipt = {
    version: 2,
    owner: "owner",
    work_id: "work",
    workflow_id: "run",
    activity_id: "step",
    attempt_id: "attempt-1",
    request_hash: "b".repeat(64),
    plan_digest: "c".repeat(64),
    grant_ref: "grant",
    grant_revision: 1,
    source: artifact,
    execution_fence: 1,
    deadline: 100,
    receipt_ref: "receipt",
    receipt_digest: "d".repeat(64),
    revision: 1,
    committed_at: 90,
    physical_state: "ceased",
    effect_certainty: "known",
    outcome: "complete",
    stages: [
      {
        stage: "execution",
        effect_key: logicalStageEffectKey("owner", "run", "step", "execution"),
        attempt_id: "attempt-1",
        state: "passed",
        started_at: 10,
        completed_at: 80,
        result: null,
      },
    ],
    output: null,
    summary: "Done",
    validation: "passed",
    validation_failures: [],
  };
  expect(workReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(workReceiptSchema.safeParse({ ...receipt, physical_state: "running" }).success).toBe(
    false,
  );
  expect(
    workReceiptSchema.safeParse({ ...receipt, validation: "unknown", validation_failures: null })
      .success,
  ).toBe(false);
  expect(workReceiptSchema.safeParse({ ...receipt, effect_certainty: "uncertain" }).success).toBe(
    false,
  );
  expect(
    workReceiptSchema.safeParse({
      ...receipt,
      stages: [{ ...receipt.stages[0], effect_key: "attempt-based-key" }],
    }).success,
  ).toBe(false);
});

it("offers reconciliation only when the owner is blocked, keeping live effects conservative", () => {
  for (const patch of [{ physical: "running" as const }, { physical: "running" as const, stop_requested: true }, { physical: "unknown" as const }]) {
    const projected = projectWorkState({ ...facts, ...patch, effect: "uncertain" });
    expect(projected.allowed_actions).not.toContain("reconcile");
    expect(projected.allowed_actions).not.toContain("retry-step");
  }
});
