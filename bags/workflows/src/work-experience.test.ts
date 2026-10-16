import { describe, expect, it } from "vitest";
import {
  WORK_REASON_META,
  WORK_STATE_META,
  buildAndValidateStartInputs,
  classifyAdmissionFailure,
  classifyStopFailure,
  derivePermittedControls,
  deriveSchemaFields,
  describeWorkProgress,
  describeWorkReason,
  describeWorkState,
  explainBlockedRun,
  extractValidationFailures,
  filterWorkItemsForView,
  formatDurationMs,
  hasValidationFailures,
  isScheduledWorkItem,
  matchesWorkView,
  projectWorkExperience,
} from "../web/waiting-reasons.js";

describe("work-experience state, validation, and cessation model (P5.1 / P5.5 / P5.7)", () => {
  it("distinguishes clean completion from completed with validation/postcondition failures", () => {
    const cleanItem = {
      work_id: "work_1",
      workflow_id: "wf_1",
      title: "Echo",
      state: "completed",
      facts: {
        coordinator: "completed",
        phase: "terminal",
        wait: "none",
        physical: "ceased",
        effect: "known",
        stop_requested: false,
        has_result: true,
      },
      allowed_actions: ["inspect", "result"],
    };
    const cleanState = describeWorkState(cleanItem);
    expect(cleanState.label).toBe("Completed");
    expect(cleanState.qualifier).toBeNull();
    expect(cleanState.badgeText).toBe("Completed");
    expect(cleanState.validationState).toBe("passed");
    expect(cleanState.physicalCessation).toBe("ceased");
    expect(hasValidationFailures(cleanItem)).toBe(false);

    const failedCheckResult = {
      retained_output: {
        validation: "failed",
        validation_failures: ["summary must include ticket reference", "exit code check failed"],
      },
      action_checks: {
        postcondition: {
          passed: false,
          unknown: false,
          detail: "Postcondition failed",
          failures: ["summary must include ticket reference"],
        },
      },
    };
    const qualifiedState = describeWorkState(cleanItem, failedCheckResult);
    expect(qualifiedState.label).toBe("Completed");
    expect(qualifiedState.qualifier).toBe("checks failed");
    expect(qualifiedState.badgeText).toBe("Completed · checks failed");
    expect(qualifiedState.validationState).toBe("failed");
    expect(extractValidationFailures(cleanItem, failedCheckResult)).toContain("summary must include ticket reference");
  });

  it("distinguishes Stop requested / Stopping from physical cessation", () => {
    const stoppingItem = {
      work_id: "work_stop",
      state: "stopping",
      facts: {
        coordinator: "running",
        phase: "executing",
        wait: "none",
        physical: "stopping",
        effect: "known",
        stop_requested: true,
        has_result: false,
      },
      reason: {
        code: "stop_requested",
        stage: "execution",
        since: 1000,
        retryable: false,
        detail: "Stop requested by caller; awaiting worker cessation.",
      },
      allowed_actions: ["inspect"],
    };
    const stopping = describeWorkState(stoppingItem);
    expect(stopping.label).toBe("Stopping");
    expect(stopping.qualifier).toBe("awaiting cessation");
    expect(stopping.badgeText).toBe("Stopping · awaiting cessation");
    expect(stopping.stopState).toBe("stopping");
    expect(stopping.physicalCessation).toBe("stopping");

    const cancelledItem = {
      ...stoppingItem,
      state: "cancelled",
      facts: {
        ...stoppingItem.facts,
        coordinator: "cancelled",
        phase: "terminal",
        physical: "ceased",
        has_result: true,
      },
    };
    const cancelled = describeWorkState(cancelledItem);
    expect(cancelled.label).toBe("Cancelled");
    expect(cancelled.stopState).toBe("stopped");
    expect(cancelled.physicalCessation).toBe("ceased");
  });

  it("distinguishes effect uncertainty and restore-paused recovery review from generic failure", () => {
    const uncertainItem = {
      work_id: "work_uncertain",
      state: "needs-attention",
      facts: {
        coordinator: "blocked",
        phase: "executing",
        wait: "none",
        physical: "unknown",
        effect: "uncertain",
        stop_requested: false,
        has_result: false,
      },
      reason: {
        code: "effect_uncertain",
        stage: "execution",
        since: 2000,
        retryable: false,
        detail: "Worker lease expired before step acknowledgement.",
      },
      can_review_reconciliation: true,
      allowed_actions: ["inspect", "reconcile"],
    };
    const uncertain = describeWorkState(uncertainItem);
    expect(uncertain.label).toBe("Needs attention");
    expect(uncertain.qualifier).toBe("effect uncertain");
    expect(uncertain.effectCertainty).toBe("uncertain");
    expect(uncertain.physicalCessation).toBe("unknown");

    const restoreItem = {
      work_id: "work_restore",
      state: "needs-attention",
      facts: {
        coordinator: "blocked",
        phase: "executing",
        wait: "none",
        physical: "unknown",
        effect: "known",
        stop_requested: false,
        has_result: false,
      },
      reason: {
        code: "restore_paused",
        stage: "recovery",
        since: 3000,
        retryable: false,
        detail: "Paused across backup restore.",
      },
    };
    const restore = describeWorkState(restoreItem);
    expect(restore.label).toBe("Needs attention");
    expect(restore.qualifier).toBe("recovery review");
  });

  it("maps all canonical reason codes and timer waits to actionable explanations", () => {
    expect(Object.keys(WORK_STATE_META).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(WORK_REASON_META)).toEqual(
      expect.arrayContaining([
        "worker_unavailable",
        "executor_unavailable",
        "nested_work_denied",
        "capability_denied",
        "secret_unavailable",
        "approval_required",
        "input_required",
        "rate_limited",
        "retry_scheduled",
        "timer_waiting",
        "external_event_waiting",
        "lease_expired",
        "effect_uncertain",
        "restore_paused",
        "stop_requested",
        "operator_stopped",
        "postcondition_failed",
        "execution_failed",
      ]),
    );

    const timerWait = describeWorkReason({
      state: "waiting",
      facts: { phase: "executing", wait: "timer" },
      reason: null,
    });
    expect(timerWait.label).toBe("Waiting (timer)");
    expect(timerWait.message).toContain("does not hold an execution slot");

    const blocked = explainBlockedRun("OutcomeUnknown: step 1 receipt missing");
    expect(blocked.title).toContain("Reconcile its destination receipt");
    expect(blocked.detail).toBe("step 1 receipt missing");
  });
});

describe("work-experience progress, views, and scheduled classification (P5.2 / P5.4)", () => {
  it("separates active execution elapsed time from pre-start queue wait and timer wait", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatDurationMs(3_900_000)).toBe("1h 5m");

    const progress = describeWorkProgress(
      {
        state: "waiting",
        accepted_at: 10_000,
        first_started_at: 15_000,
        facts: { phase: "executing", wait: "timer" },
      },
      75_000,
    );
    expect(progress.preStartWaitMs).toBe(5_000);
    expect(progress.executionElapsedMs).toBe(60_000);
    expect(progress.totalElapsedMs).toBe(65_000);
    expect(progress.timingSummary).toContain("Elapsed since first start: 1m");
    expect(progress.timingSummary).toContain("Queue wait before start: 5s");
    expect(progress.timingSummary).toContain("Current wait: timer (no execution slot held)");
  });

  it("classifies active, attention, scheduled, and history views accurately", () => {
    const items = [
      { work_id: "w_active", state: "running", origin: { trigger: "manual" }, facts: { wait: "none" } },
      { work_id: "w_sched", state: "waiting", origin: { trigger: "schedule" }, facts: { wait: "timer" } },
      { work_id: "w_attn", state: "needs-attention", origin: { trigger: "manual" }, facts: { effect: "uncertain" } },
      { work_id: "w_done", state: "completed", origin: { trigger: "manual" }, facts: { wait: "none" } },
    ];
    expect(isScheduledWorkItem(items[1])).toBe(true);
    expect(isScheduledWorkItem(items[0])).toBe(false);
    expect(matchesWorkView(items[1], "scheduled")).toBe(true);
    expect(filterWorkItemsForView(items, "active").map(i => i.work_id)).toEqual(["w_active", "w_sched"]);
    expect(filterWorkItemsForView(items, "attention").map(i => i.work_id)).toEqual(["w_attn"]);
    expect(filterWorkItemsForView(items, "scheduled").map(i => i.work_id)).toEqual(["w_sched"]);
    expect(filterWorkItemsForView(items, "history").map(i => i.work_id)).toEqual(["w_done"]);
  });
});

describe("schema-driven start fields and pre-submit validation (P5.3)", () => {
  const definition = {
    kind: "action",
    reference: "demo:deploy",
    title: "Deploy Service",
    input_schema: {
      type: "object",
      required: ["environment", "replicas"],
      properties: {
        environment: {
          type: "string",
          title: "Environment",
          description: "Target deployment stage",
          enum: ["staging", "production"],
          default: "staging",
        },
        replicas: {
          type: "integer",
          title: "Replicas",
          minimum: 1,
          maximum: 10,
          default: 2,
        },
        dryRun: {
          type: "boolean",
          title: "Dry run",
          default: false,
        },
        metadata: {
          type: "object",
          title: "Metadata",
        },
      },
    },
  };

  it("derives appropriate form controls from JSON Schema properties", () => {
    const fields = deriveSchemaFields(definition);
    expect(fields.map(f => ({ name: f.name, control: f.control, required: f.required }))).toEqual([
      { name: "environment", control: "select", required: true },
      { name: "replicas", control: "number", required: true },
      { name: "dryRun", control: "checkbox", required: false },
      { name: "metadata", control: "json", required: false },
    ]);
  });

  it("rejects invalid required, enum, integer range, and JSON inputs locally before network admission", () => {
    const invalid = buildAndValidateStartInputs(definition, {
      environment: "invalid-env",
      replicas: "0",
      dryRun: true,
      metadata: "{bad-json",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.fieldErrors.environment).toContain("staging, production");
    expect(invalid.fieldErrors.replicas).toContain("at least 1");
    expect(invalid.fieldErrors.metadata).toContain("valid JSON");

    const valid = buildAndValidateStartInputs(definition, {
      environment: "production",
      replicas: "3",
      dryRun: true,
      metadata: '{"ticket":"INC-42"}',
    });
    expect(valid.ok).toBe(true);
    expect(valid.inputs).toEqual({
      environment: "production",
      replicas: 3,
      dryRun: true,
      metadata: { ticket: "INC-42" },
    });
  });
});

describe("admission, stop, and permitted control reconciliation (P5.5 / P5.6)", () => {
  it("distinguishes explicit pre-acceptance refusal from ambiguous admission failure and preserves prior ambiguity", () => {
    const refused = classifyAdmissionFailure({
      message: "Restore admission is paused.",
      admissionDisposition: "not-accepted",
    });
    expect(refused.outcome).toBe("refused");
    expect(refused.preserveKey).toBe(false);

    const ambiguous = classifyAdmissionFailure({
      message: "Network connection lost",
      transportFailed: true,
    });
    expect(ambiguous.outcome).toBe("ambiguous");
    expect(ambiguous.preserveKey).toBe(true);

    const refusedAfterAmbiguous = classifyAdmissionFailure(
      { message: "Key conflict or policy changed", admissionDisposition: "refused" },
      true,
    );
    expect(refusedAfterAmbiguous.outcome).toBe("ambiguous");
    expect(refusedAfterAmbiguous.preserveKey).toBe(true);
  });

  it("distinguishes stale-revision / pre-mutation Stop refusal from unconfirmed Stop reply", () => {
    const staleRevision = classifyStopFailure({
      status: 409,
      code: "WorkRevisionConflict",
      stopDisposition: "refused",
      message: "Work revision changed before stop was applied.",
    });
    expect(staleRevision.outcome).toBe("refused");
    expect(staleRevision.preserveIntent).toBe(false);
    expect(staleRevision.refreshRequired).toBe(true);

    const lostStopReply = classifyStopFailure({
      status: 503,
      code: "WorkStopUnknown",
      message: "Stop acknowledgement timed out",
    });
    expect(lostStopReply.outcome).toBe("ambiguous");
    expect(lostStopReply.preserveIntent).toBe(true);
  });

  it("derives only server-authorized controls and distinguishes missing result from policy denial", () => {
    const runningItem = {
      work_id: "work_run",
      state: "running",
      facts: { has_result: false, stop_requested: false },
      allowed_actions: ["inspect", "stop"],
      can_review_reconciliation: false,
    };
    const runningControls = derivePermittedControls(runningItem);
    expect(runningControls.controls.map(c => c.action)).toEqual(["stop"]);
    expect(runningControls.unavailableNotices).toContainEqual({
      action: "result",
      reason: "No result yet while execution is still in progress.",
    });

    const deniedResultItem = {
      work_id: "work_denied",
      state: "completed",
      facts: { has_result: true, stop_requested: false },
      allowed_actions: ["inspect"],
      can_review_reconciliation: false,
    };
    const deniedControls = derivePermittedControls(deniedResultItem);
    expect(deniedControls.unavailableNotices).toContainEqual({
      action: "result",
      reason: "Result exists, but current policy or session authority does not permit reading the payload.",
    });

    const summary = projectWorkExperience(deniedResultItem, null, 10_000);
    expect(summary.workId).toBe("work_denied");
    expect(summary.state.label).toBe("Completed");
  });
});
