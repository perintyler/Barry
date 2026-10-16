const blockedReasons = [
  [/^PolicyRevoked(?::\s*(.*))?$/, "Permissions changed after this run was approved. Review the current scope and reauthorize only after outstanding effects are reconciled."],
  [/^OutcomeUnknown(?::\s*(.*))?$/, "An effect or session turn may have completed without an acknowledgement. Reconcile its destination receipt before retrying."],
  [/^SessionBusy(?::\s*(.*))?$/, "Another turn still owns this continuing session. Wait for or reconcile that turn before submitting another."],
  [/^ReconciliationRequired(?::\s*(.*))?$/, "This run has unresolved external work. Inspect its session and effect receipts before resuming."],
  [/^RequiredContainmentUnavailable(?::\s*(.*))?$/, "No available worker can enforce the run’s required execution profile."],
];

export function explainBlockedRun(error) {
  if (typeof error !== "string") return { title: "Run blocked", detail: "The run is blocked; inspect its event history and resource receipts." };
  for (const [pattern, title] of blockedReasons) {
    const match = pattern.exec(error);
    if (match) return { title, detail: match[1] || error };
  }
  return { title: "Run blocked", detail: error };
}

export const WORK_STATE_META = {
  accepted: {
    label: "Accepted",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "not-started",
    stopState: "none",
    explanation: "Durable work is recorded and owned by the service, waiting to enter the execution queue.",
  },
  queued: {
    label: "Queued",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "not-started",
    stopState: "none",
    explanation: "Accepted. Waiting for an executor that meets the task’s current requirements.",
  },
  running: {
    label: "Running",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "running",
    stopState: "none",
    explanation: "Execution is in progress. Closing this page does not stop it.",
  },
  waiting: {
    label: "Waiting",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "running",
    stopState: "none",
    explanation: "Paused on a timer, dependency, or external signal without holding an execution slot.",
  },
  "waiting-for-approval": {
    label: "Waiting for approval",
    category: "attention",
    logicalOutcome: "pending",
    physicalCessation: "running",
    stopState: "none",
    explanation: "Waiting for an explicit approval or caller decision before continuing.",
  },
  "needs-attention": {
    label: "Needs attention",
    category: "attention",
    logicalOutcome: "pending",
    physicalCessation: "unknown",
    stopState: "none",
    explanation: "The outcome or execution ownership needs review. Inspect the retained evidence before taking another action.",
  },
  attention_required: {
    label: "Needs attention",
    category: "attention",
    logicalOutcome: "pending",
    physicalCessation: "unknown",
    stopState: "none",
    explanation: "The outcome or execution ownership needs review. Inspect the retained evidence before taking another action.",
  },
  blocked: {
    label: "Blocked",
    category: "attention",
    logicalOutcome: "pending",
    physicalCessation: "not-started",
    stopState: "none",
    explanation: "Execution is paused by a capability, secret, restore boundary, or policy block.",
  },
  stop_requested: {
    label: "Stop requested",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "running",
    stopState: "requested",
    explanation: "Stop was requested. Physical cessation has not yet been confirmed.",
  },
  stopping: {
    label: "Stopping",
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: "stopping",
    stopState: "stopping",
    explanation: "Stop was requested. Physical cessation has not yet been confirmed.",
  },
  cancelled: {
    label: "Cancelled",
    category: "history",
    logicalOutcome: "cancelled",
    physicalCessation: "ceased",
    stopState: "stopped",
    explanation: "The task was cancelled and execution cessation is confirmed.",
  },
  stopped: {
    label: "Cancelled",
    category: "history",
    logicalOutcome: "cancelled",
    physicalCessation: "ceased",
    stopState: "stopped",
    explanation: "The task was cancelled and execution cessation is confirmed.",
  },
  completed: {
    label: "Completed",
    category: "history",
    logicalOutcome: "completed",
    physicalCessation: "ceased",
    stopState: "none",
    explanation: "The task finished and its result is available.",
  },
  failed: {
    label: "Failed",
    category: "history",
    logicalOutcome: "failed",
    physicalCessation: "ceased",
    stopState: "none",
    explanation: "The task failed. Its result may include retained partial output.",
  },
};

export const WORK_REASON_META = {
  worker_unavailable: {
    label: "No eligible worker connected",
    category: "capacity",
    guidance: "Connect or start a compatible worker; the task remains queued.",
  },
  executor_unavailable: {
    label: "Executor unavailable",
    category: "capacity",
    guidance: "The required execution adapter is unavailable on the worker.",
  },
  nested_work_denied: {
    label: "Nested background submission denied",
    category: "policy",
    guidance: "Detached work cannot spawn another detached background task.",
  },
  capability_denied: {
    label: "Capability or permission denied",
    category: "permission",
    guidance: "Current authority or bounds do not permit this step.",
  },
  secret_unavailable: {
    label: "Required secret unavailable",
    category: "configuration",
    guidance: "Bind or unlock the required secret before continuing.",
  },
  approval_required: {
    label: "Waiting for approval decision",
    category: "decision",
    guidance: "Execution is paused waiting for an explicit approval decision.",
  },
  input_required: {
    label: "Waiting for caller input",
    category: "decision",
    guidance: "Execution is paused waiting for additional structured input.",
  },
  rate_limited: {
    label: "Rate limited",
    category: "wait",
    guidance: "Waiting for the rate-limit window to clear.",
  },
  retry_scheduled: {
    label: "Retry scheduled",
    category: "wait",
    guidance: "A retry timer is scheduled after a transient step failure.",
  },
  timer_waiting: {
    label: "Timer waiting",
    category: "wait",
    guidance: "Waiting until the scheduled wake timestamp.",
  },
  external_event_waiting: {
    label: "Waiting for external signal",
    category: "wait",
    guidance: "Waiting for an external event or signal to arrive.",
  },
  lease_expired: {
    label: "Worker lease expired",
    category: "uncertainty",
    guidance: "The worker stopped heartbeating before confirming whether the step completed.",
  },
  effect_uncertain: {
    label: "External effect uncertain",
    category: "uncertainty",
    guidance: "A step may have mutated external state before its reply was lost. Verify before re-running.",
  },
  restore_paused: {
    label: "Paused across backup restore",
    category: "recovery",
    guidance: "Database was restored from backup; review recovery epoch and side effects before continuing.",
  },
  stop_requested: {
    label: "Stop requested",
    category: "stop",
    guidance: "Stop has been requested and is awaiting worker cessation.",
  },
  operator_stopped: {
    label: "Stopped by caller or operator",
    category: "stop",
    guidance: "Execution was intentionally stopped.",
  },
  postcondition_failed: {
    label: "Postcondition or validation check failed",
    category: "validation",
    guidance: "The task ran, but one or more postcondition/validation checks failed.",
  },
  execution_failed: {
    label: "Execution failed",
    category: "failure",
    guidance: "The step or action threw an execution error.",
  },
};

export function hasValidationFailures(item, result) {
  const retainedFailures = result?.retained_output?.validation_failures ?? item?.validation_failures;
  if (Array.isArray(retainedFailures) && retainedFailures.length > 0) return true;
  if (result?.retained_output?.validation === "failed") return true;
  const checks = result?.action_checks ?? item?.action_checks;
  if (checks) {
    for (const report of Object.values(checks)) {
      if (report && (!report.passed || report.unknown || (Array.isArray(report.failures) && report.failures.length > 0))) {
        return true;
      }
    }
  }
  if (item?.facts?.action_checks === "failed" || item?.facts?.postcondition === "failed") return true;
  if (item?.reason?.code === "postcondition_failed" || item?.reason?.stage === "validation" || item?.reason?.stage === "postcondition") return true;
  return false;
}

export function extractValidationFailures(item, result) {
  const list = [];
  const retained = result?.retained_output?.validation_failures ?? item?.validation_failures;
  if (Array.isArray(retained)) list.push(...retained);
  const checks = result?.action_checks ?? item?.action_checks;
  if (checks) {
    for (const [stage, report] of Object.entries(checks)) {
      if (!report) continue;
      if (Array.isArray(report.failures) && report.failures.length > 0) {
        list.push(...report.failures);
      } else if (!report.passed) {
        list.push(report.detail || `${stage} check did not pass`);
      }
    }
  }
  return list;
}

export function describeWorkState(item, result) {
  const rawState = item?.state ?? item?.status ?? "queued";
  const normalized = rawState === "started"
    ? "running"
    : rawState === "complete"
      ? "completed"
      : rawState === "abandoned"
        ? "failed"
        : rawState;
  const base = WORK_STATE_META[normalized] ?? {
    label: String(rawState),
    category: "active",
    logicalOutcome: "pending",
    physicalCessation: item?.facts?.physical ?? "running",
    stopState: "none",
    explanation: "Waiting for the next permitted action.",
  };
  const checksFailed = hasValidationFailures(item, result);
  const physical = item?.facts?.physical ?? base.physicalCessation;
  const effect = item?.facts?.effect ?? (["completed", "cancelled", "stopped", "failed"].includes(normalized) ? "known" : "not-started");
  const effectUncertain = effect === "uncertain" || item?.reason?.code === "effect_uncertain" || item?.reason?.code === "lease_expired";
  const restorePaused = item?.reason?.code === "restore_paused" || item?.reason?.stage === "recovery";
  const stopRequestedFact = Boolean(item?.facts?.stop_requested);

  let qualifier = null;
  if (normalized === "completed" && checksFailed) {
    qualifier = "checks failed";
  } else if (normalized === "stopping" || normalized === "stop_requested" || (stopRequestedFact && !["cancelled", "stopped"].includes(normalized))) {
    qualifier = physical === "ceased" ? "cessation confirmed" : "awaiting cessation";
  } else if (effectUncertain) {
    qualifier = "effect uncertain";
  } else if (restorePaused) {
    qualifier = "recovery review";
  } else if (normalized === "waiting" && item?.facts?.wait && item.facts.wait !== "none") {
    const waitKind = typeof item.facts.wait === "string" ? item.facts.wait : item.facts.wait.kind;
    if (waitKind) qualifier = `waiting on ${String(waitKind).replace(/[-_]/g, " ")}`;
  }

  const badgeText = qualifier ? `${base.label} · ${qualifier}` : base.label;
  const validationState = checksFailed
    ? "failed"
    : normalized === "completed"
      ? "passed"
      : "not_run";
  const stopState = ["cancelled", "stopped"].includes(normalized)
    ? "stopped"
    : (normalized === "stopping" || normalized === "stop_requested" || stopRequestedFact)
      ? "stopping"
      : "none";

  let explanation = item?.reason?.detail || item?.reason?.message || base.explanation;
  if (!item?.reason && normalized === "waiting" && (item?.facts?.wait === "timer" || item?.facts?.wait?.kind === "timer")) {
    explanation = "Waiting for the task’s timer. It does not hold an execution slot while it waits.";
  } else if (normalized === "completed" && checksFailed) {
    explanation = "The task finished and physical execution ceased, but validation or postcondition checks reported failures.";
  }

  return {
    state: normalized,
    label: base.label,
    qualifier,
    badgeText,
    category: base.category,
    logicalOutcome: item?.facts?.coordinator ?? base.logicalOutcome,
    physicalCessation: physical,
    effectCertainty: effect,
    validationState,
    stopState,
    explanation,
  };
}

export function describeWorkReason(item) {
  const reason = item?.reason;
  const wait = item?.facts?.wait;
  if (!reason) {
    if (wait && wait !== "none") {
      const waitKind = typeof wait === "string" ? wait : wait.kind;
      const waitDetail = typeof wait === "object" && wait ? wait.detail : null;
      const waitUntil = typeof wait === "object" && wait ? wait.until : null;
      return {
        code: null,
        stage: item?.facts?.phase ?? "queued",
        label: `Waiting (${String(waitKind).replace(/[-_]/g, " ")})`,
        message: waitDetail || (waitKind === "timer" ? "Waiting for the task’s timer. It does not hold an execution slot while it waits." : "Paused on a scheduled or external condition."),
        guidance: waitUntil ? `Scheduled until ${waitUntil}.` : "No worker execution slot is held while waiting.",
        retryable: true,
      };
    }
    return {
      code: null,
      stage: item?.facts?.phase ?? null,
      label: "Normal operation",
      message: item?.summary || "No blocking or failure reason recorded.",
      guidance: null,
      retryable: false,
    };
  }
  const meta = WORK_REASON_META[reason.code] ?? {
    label: String(reason.code || "Notice").replace(/[-_]/g, " "),
    category: reason.stage || "general",
    guidance: null,
  };
  const detailText = reason.detail || reason.message || meta.label;
  return {
    code: reason.code,
    stage: reason.stage ?? null,
    since: reason.since ?? null,
    label: meta.label,
    category: meta.category,
    message: detailText,
    detail: detailText,
    guidance: meta.guidance,
    retryable: Boolean(reason.retryable),
    until: reason.until ?? null,
    attemptId: reason.attempt_id ?? null,
  };
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

export function describeWorkProgress(item, nowMs = Date.now()) {
  const acceptedMs = toEpochMs(item?.accepted_at ?? item?.timestamps?.accepted_at ?? item?.started_at);
  const startedMs = toEpochMs(item?.first_started_at ?? item?.timestamps?.started_at);
  const completedMs = toEpochMs(item?.closed_at ?? item?.completed_at ?? item?.timestamps?.completed_at);
  const isTerminal = ["completed", "failed", "cancelled", "stopped"].includes(item?.state ?? item?.status);
  const endMs = Number.isFinite(completedMs) ? completedMs : nowMs;

  const totalElapsedMs = Number.isFinite(acceptedMs) ? Math.max(0, endMs - acceptedMs) : null;
  const executionElapsedMs = Number.isFinite(startedMs) ? Math.max(0, endMs - startedMs) : null;
  const preStartWaitMs = Number.isFinite(acceptedMs)
    ? Math.max(0, (Number.isFinite(startedMs) ? startedMs : endMs) - acceptedMs)
    : null;

  const phase = item?.facts?.phase ?? (isTerminal ? "terminal" : Number.isFinite(startedMs) ? "executing" : "queued");
  const rawWait = item?.facts?.wait;
  const waitKind = typeof rawWait === "string" ? (rawWait === "none" ? null : rawWait) : (rawWait?.kind ?? null);

  const stageLabel = waitKind
    ? `Waiting (${String(waitKind).replace(/[-_]/g, " ")})`
    : `Phase: ${String(phase).replace(/[-_]/g, " ")}`;

  const timingParts = [];
  if (executionElapsedMs !== null) {
    timingParts.push(`${isTerminal ? "Execution window" : "Elapsed since first start"}: ${formatDurationMs(executionElapsedMs)}`);
  } else {
    timingParts.push("Execution has not started");
  }
  if (preStartWaitMs !== null && preStartWaitMs >= 1000) {
    timingParts.push(`Queue wait before start: ${formatDurationMs(preStartWaitMs)}`);
  } else if (totalElapsedMs !== null && executionElapsedMs === null) {
    timingParts.push(`Waiting in queue: ${formatDurationMs(totalElapsedMs)}`);
  }
  if (waitKind) {
    timingParts.push(`Current wait: ${String(waitKind).replace(/[-_]/g, " ")} (no execution slot held)`);
  }

  return {
    phase,
    waitKind,
    stageLabel,
    timingSummary: timingParts.join(" · "),
    totalElapsedMs,
    executionElapsedMs,
    preStartWaitMs,
    isWaiting: Boolean(waitKind) || ["waiting", "waiting-for-approval", "queued", "accepted"].includes(item?.state),
  };
}

export function isScheduledWorkItem(item) {
  if (!item) return false;
  if (item.origin?.trigger === "schedule" || item.trigger === "schedule") return true;
  if (typeof item.origin?.entry_point === "string" && item.origin.entry_point.includes("schedule")) return true;
  if (item.facts?.wait === "timer" || item.facts?.wait?.kind === "timer") return true;
  if (item.reason?.code === "timer_waiting" || item.reason?.code === "retry_scheduled") return true;
  return false;
}

export function matchesWorkView(item, view) {
  if (!item) return false;
  const state = item.state ?? item.status;
  if (view === "attention") {
    return ["needs-attention", "attention_required", "blocked", "waiting-for-approval"].includes(state)
      || item.facts?.effect === "uncertain"
      || item.facts?.physical === "unknown"
      || item.reason?.code === "effect_uncertain"
      || item.reason?.code === "restore_paused"
      || item.reason?.code === "lease_expired";
  }
  if (view === "scheduled") {
    return isScheduledWorkItem(item);
  }
  if (view === "history") {
    return ["completed", "failed", "cancelled", "stopped", "complete", "abandoned"].includes(state);
  }
  return ["accepted", "queued", "running", "waiting", "waiting-for-approval", "stop_requested", "stopping", "started"].includes(state);
}

export function filterWorkItemsForView(items, view) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => matchesWorkView(item, view));
}

export function deriveSchemaFields(definition) {
  const schema = definition?.input_schema;
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const requiredSet = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields = [];

  for (const [name, rawSpec] of Object.entries(properties)) {
    const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : {};
    const enumValues = Array.isArray(spec.enum) ? spec.enum.map(v => String(v)) : null;
    const rawType = Array.isArray(spec.type) ? spec.type.find(t => t !== "null") ?? spec.type[0] : spec.type;
    const isDelayMs = name === "delayMs" && (rawType === "integer" || rawType === "number");
    let control = "text";
    if (enumValues && enumValues.length > 0) {
      control = "select";
    } else if (rawType === "boolean") {
      control = "checkbox";
    } else if (rawType === "number" || rawType === "integer") {
      control = "number";
    } else if (rawType === "object" || rawType === "array") {
      control = "json";
    } else if (name === "message") {
      control = "textarea";
    }
    const defaultLabel = isDelayMs
      ? "Delay (seconds)"
      : (typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : name.charAt(0).toUpperCase() + name.slice(1));
    fields.push({
      name,
      id: `work-field-${fields.length}`,
      descId: `work-field-${fields.length}-desc`,
      errorId: `work-field-${fields.length}-error`,
      label: defaultLabel,
      description: typeof spec.description === "string" && spec.description.trim() ? spec.description.trim() : null,
      type: rawType || (enumValues ? "string" : "string"),
      control,
      required: requiredSet.has(name),
      defaultValue: spec.default !== undefined ? spec.default : (isDelayMs || rawType === "number" || rawType === "integer" ? 0 : name === "message" ? "Hello from Barry" : undefined),
      enumValues,
      minimum: typeof spec.minimum === "number" ? (isDelayMs ? spec.minimum / 1000 : spec.minimum) : undefined,
      maximum: typeof spec.maximum === "number" ? (isDelayMs ? spec.maximum / 1000 : spec.maximum) : undefined,
      step: typeof spec.multipleOf === "number" ? spec.multipleOf : (rawType === "integer" || isDelayMs ? 1 : "any"),
      scaleMultiplier: isDelayMs ? 1000 : 1,
    });
  }
  return fields;
}

export function buildAndValidateStartInputs(definition, rawFieldValues, extraJsonText = "", useRawJsonOnly = false) {
  if (useRawJsonOnly) {
    try {
      const parsed = JSON.parse(extraJsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, inputs: {}, fieldErrors: {}, extraError: "Input JSON must be a JSON object." };
      }
      return { ok: true, inputs: parsed, fieldErrors: {}, extraError: null };
    } catch (error) {
      return { ok: false, inputs: {}, fieldErrors: {}, extraError: error instanceof Error ? error.message : "Input JSON is not valid JSON." };
    }
  }

  const fields = deriveSchemaFields(definition);
  const fieldErrors = {};
  const values = {};

  for (const field of fields) {
    const raw = rawFieldValues?.[field.name];
    if (field.control === "checkbox") {
      values[field.name] = Boolean(raw);
      continue;
    }
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (text === "") {
      if (field.required) {
        fieldErrors[field.name] = `${field.label} is required.`;
      } else if (field.type === "string" && raw === "") {
        values[field.name] = "";
      }
      continue;
    }
    if (field.control === "select" && field.enumValues) {
      if (!field.enumValues.includes(text)) {
        fieldErrors[field.name] = `${field.label} must be one of: ${field.enumValues.join(", ")}.`;
        continue;
      }
      values[field.name] = text;
      continue;
    }
    if (field.control === "number") {
      const num = Number(text);
      if (!Number.isFinite(num)) {
        fieldErrors[field.name] = `${field.label} must be a valid number.`;
        continue;
      }
      if (field.type === "integer" && !Number.isInteger(num * field.scaleMultiplier)) {
        fieldErrors[field.name] = `${field.label} must be a whole number.`;
        continue;
      }
      if (field.minimum !== undefined && num < field.minimum) {
        fieldErrors[field.name] = `${field.label} must be at least ${field.minimum}.`;
        continue;
      }
      if (field.maximum !== undefined && num > field.maximum) {
        fieldErrors[field.name] = `${field.label} must be at most ${field.maximum}.`;
        continue;
      }
      values[field.name] = num * field.scaleMultiplier;
      continue;
    }
    if (field.control === "json") {
      try {
        values[field.name] = JSON.parse(text);
      } catch {
        fieldErrors[field.name] = `${field.label} must be valid JSON.`;
      }
      continue;
    }
    values[field.name] = raw === undefined || raw === null ? "" : String(raw);
  }

  let extraError = null;
  const trimmedExtra = typeof extraJsonText === "string" ? extraJsonText.trim() : "";
  if (trimmedExtra) {
    try {
      const parsed = JSON.parse(trimmedExtra);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        extraError = "Advanced JSON input must be a JSON object.";
      } else {
        Object.assign(values, parsed);
        for (const key of Object.keys(parsed)) {
          if (parsed[key] !== undefined && parsed[key] !== null && parsed[key] !== "") {
            delete fieldErrors[key];
          }
        }
      }
    } catch {
      extraError = "Advanced JSON input is not valid JSON.";
    }
  }

  const ok = Object.keys(fieldErrors).length === 0 && !extraError;
  return {
    ok,
    inputs: values,
    fieldErrors,
    extraError,
  };
}

export function classifyAdmissionFailure(error, priorAmbiguous = false) {
  const disposition = error?.admissionDisposition ?? error?.admission_disposition;
  const explicitlyRefused = disposition === "not-accepted" || disposition === "refused";
  if (!priorAmbiguous && explicitlyRefused) {
    return {
      outcome: "refused",
      preserveKey: false,
      message: error?.message || "Task was refused before acceptance. You can edit the inputs and submit with a new key.",
    };
  }
  return {
    outcome: "ambiguous",
    preserveKey: true,
    message: priorAmbiguous && explicitlyRefused
      ? `Earlier submission remains unconfirmed (${error?.message || "retry was refused"}). Check submission status by original key before starting a new invocation.`
      : (error?.message || "Submission outcome is not confirmed. Preserve this key and check submission status or retry the exact same request."),
  };
}

export function classifyStopFailure(error, priorAmbiguous = false) {
  const disposition = error?.stopDisposition ?? error?.stop_disposition;
  const code = error?.code;
  const status = error?.status;
  const canonicalRefusal = disposition === "refused"
    || disposition === "not-accepted"
    || (status === 409 && (code === "WorkRevisionConflict" || code === "WorkStopUnavailable" || !code))
    || (status === 404 && code === "WorkNotFound")
    || (status === 403 && (code === "Forbidden" || code === "WorkReadDenied" || code === "WorkControlDenied"));

  if (!priorAmbiguous && canonicalRefusal) {
    return {
      outcome: "refused",
      preserveIntent: false,
      refreshRequired: true,
      message: error?.message || "Stop request was refused because the task state or revision changed. Refreshing current task state.",
    };
  }
  return {
    outcome: "ambiguous",
    preserveIntent: true,
    refreshRequired: true,
    message: error?.message || "Stop acknowledgement was not confirmed. Preserve the request ID, revision, and reason until status is checked or resent.",
  };
}

export function derivePermittedControls(item, result) {
  const allowed = new Set(Array.isArray(item?.allowed_actions) ? item.allowed_actions : []);
  const state = item?.state;
  const hasResult = Boolean(item?.facts?.has_result) || Boolean(result);
  const controls = [];
  const unavailableNotices = [];

  if (allowed.has("result")) {
    controls.push({
      action: "result",
      label: "View result",
      supported: true,
      description: "Load the canonical result and retained output.",
    });
  } else if (hasResult) {
    unavailableNotices.push({
      action: "result",
      reason: "Result exists, but current policy or session authority does not permit reading the payload.",
    });
  } else if (["queued", "running", "waiting", "waiting-for-approval", "stopping"].includes(state)) {
    unavailableNotices.push({
      action: "result",
      reason: "No result yet while execution is still in progress.",
    });
  }

  if (allowed.has("stop")) {
    controls.push({
      action: "stop",
      label: "Stop task",
      supported: true,
      description: "Request cooperative workflow Stop at the current inspected revision.",
    });
  } else if (state === "stopping" || item?.facts?.stop_requested) {
    unavailableNotices.push({
      action: "stop",
      reason: "Stop is already requested and awaiting physical worker cessation.",
    });
  }

  if (allowed.has("reconcile") && item?.can_review_reconciliation) {
    controls.push({
      action: "reconcile",
      label: "Review recovery evidence",
      supported: true,
      description: "Review retained executor receipts and apply a verified outcome.",
    });
  } else if (item?.can_review_reconciliation) {
    controls.push({
      action: "reconcile-inspect",
      label: "Review recovery evidence",
      supported: true,
      description: "Inspect retained executor receipts and recorded reconciliation decisions.",
    });
  }

  if (allowed.has("run-again") || allowed.has("rerun")) {
    controls.push({
      action: "run-again",
      label: "Run again",
      supported: true,
      description: "Prepare a new task invocation with a fresh idempotency key.",
    });
  }

  if (allowed.has("continue")) {
    controls.push({
      action: "continue",
      label: "Continue",
      supported: false,
      description: "Server marks Continue as eligible once a v2 continue endpoint is exposed; use the execution inspector if manual resume is needed.",
    });
  }

  if (allowed.has("retry-step") || allowed.has("retry")) {
    controls.push({
      action: "retry-step",
      label: "Retry failed step",
      supported: false,
      description: "Server marks Retry failed step as eligible once a v2 step-retry endpoint is exposed.",
    });
  }

  if (allowed.has("respond") || state === "waiting-for-approval") {
    controls.push({
      action: "respond",
      label: "Respond to decision",
      supported: false,
      description: "This task is waiting for an approval or decision response; typed v2 decision submission is not yet wired on this route.",
    });
  }

  return { controls, unavailableNotices };
}

export function projectWorkExperience(item, result, nowMs = Date.now()) {
  return {
    workId: typeof item?.work_id === "string" ? item.work_id : String(item?.id ?? ""),
    workflowId: typeof item?.workflow_id === "string" ? item.workflow_id : null,
    title: typeof item?.title === "string" ? item.title : String(item?.action ?? item?.work_id ?? "Task"),
    state: describeWorkState(item, result),
    reason: describeWorkReason(item),
    progress: describeWorkProgress(item, nowMs),
    controls: derivePermittedControls(item, result),
    validationFailures: extractValidationFailures(item, result),
  };
}
