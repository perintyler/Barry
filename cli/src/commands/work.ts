import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { approveWorkflowBounds } from "@barry-rocks/sdk/bounds";
import { bagDataDir, serviceAddress } from "@barry-rocks/sdk/services";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import {
  WorkDelegationIssuer,
  readWorkDelegationKeys,
  workDelegationSigningKey,
  projectWorkState,
  workReconciliationSchema,
  recoveryActivationSchema,
  type WorkAuthority,
} from "@barry-rocks/sdk/internal/workflows";
import { currentTarget } from "../target.js";
import { runWorkOps } from "./work-ops-cli.js";

const ref = z.string().min(1).max(200);
const issuerName = "workflows.cli.operator";

export interface WorkCliError extends Error {
  status?: number;
  code?: string;
  admissionDisposition?: string;
  stopDisposition?: string;
  retryable?: boolean;
  transportFailed?: boolean;
}

const STATE_LABELS: Record<string, string> = {
  accepted: "Accepted",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  "waiting-for-approval": "Waiting for approval",
  "needs-attention": "Needs attention",
  attention_required: "Needs attention",
  blocked: "Blocked",
  stop_requested: "Stop requested",
  stopping: "Stopping",
  cancelled: "Cancelled",
  stopped: "Cancelled",
  completed: "Completed",
  failed: "Failed",
};

const REASON_LABELS: Record<string, string> = {
  worker_unavailable: "No eligible worker connected",
  executor_unavailable: "Executor unavailable",
  nested_work_denied: "Nested background submission denied",
  capability_denied: "Capability or permission denied",
  secret_unavailable: "Required secret unavailable",
  approval_required: "Waiting for approval decision",
  input_required: "Waiting for caller input",
  rate_limited: "Rate limited",
  retry_scheduled: "Retry scheduled",
  timer_waiting: "Timer waiting",
  external_event_waiting: "Waiting for external signal",
  lease_expired: "Worker lease expired",
  effect_uncertain: "External effect uncertain",
  restore_paused: "Paused across backup restore",
  stop_requested: "Stop requested",
  operator_stopped: "Stopped by caller or operator",
  postcondition_failed: "Postcondition or validation check failed",
  execution_failed: "Execution failed",
};

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value));
}

export function extractCliValidationFailures(
  item?: object | null,
  result?: object | null,
): string[] {
  const itemRec = toRecord(item);
  const resultRec = toRecord(result);
  const failures: string[] = [];
  const retained =
    toRecord(resultRec.retained_output).validation_failures ?? itemRec.validation_failures;
  if (Array.isArray(retained)) {
    for (const entry of retained) if (typeof entry === "string" && entry) failures.push(entry);
  }
  const checks = toRecord(resultRec.action_checks ?? itemRec.action_checks);
  for (const [stage, rawReport] of Object.entries(checks)) {
    if (!rawReport || typeof rawReport !== "object") continue;
    const report = toRecord(rawReport);
    if (Array.isArray(report.failures) && report.failures.length > 0) {
      for (const f of report.failures) if (typeof f === "string" && f) failures.push(f);
    } else if (report.passed === false) {
      failures.push(
        typeof report.detail === "string" && report.detail
          ? report.detail
          : `${stage} check did not pass`,
      );
    }
  }
  return [...new Set(failures)];
}

export function presentCliWorkItem(item: object, result?: object | null) {
  const itemRec = toRecord(item);
  const resultRec = result ? toRecord(result) : null;
  const rawState = String(itemRec.state ?? itemRec.status ?? "queued");
  const normalized =
    rawState === "started" ? "running" : rawState === "complete" ? "completed" : rawState;
  const label = STATE_LABELS[normalized] ?? rawState;
  const facts = toRecord(itemRec.facts);
  const reason =
    itemRec.reason && typeof itemRec.reason === "object" ? toRecord(itemRec.reason) : null;
  const validationFailures = extractCliValidationFailures(itemRec, resultRec);
  const retainedValidation = resultRec ? toRecord(resultRec.retained_output).validation : undefined;
  const checksFailed =
    validationFailures.length > 0 ||
    retainedValidation === "failed" ||
    reason?.code === "postcondition_failed";
  const physical = String(
    facts.physical ??
      (["completed", "failed", "cancelled"].includes(normalized) ? "ceased" : "running"),
  );
  const effect = String(
    facts.effect ??
      (["completed", "failed", "cancelled"].includes(normalized) ? "known" : "not-started"),
  );
  const stopRequested =
    Boolean(facts.stop_requested) || normalized === "stopping" || normalized === "stop_requested";

  let qualifier: string | null = null;
  if (normalized === "completed" && checksFailed) {
    qualifier = "checks failed";
  } else if (stopRequested && !["cancelled", "stopped"].includes(normalized)) {
    qualifier = physical === "ceased" ? "cessation confirmed" : "awaiting cessation";
  } else if (
    effect === "uncertain" ||
    reason?.code === "effect_uncertain" ||
    reason?.code === "lease_expired"
  ) {
    qualifier = "effect uncertain";
  } else if (reason?.code === "restore_paused" || reason?.stage === "recovery") {
    qualifier = "recovery review";
  } else if (normalized === "waiting" && facts.wait && facts.wait !== "none") {
    qualifier = `waiting on ${String(facts.wait).replace(/[-_]/g, " ")}`;
  }

  const badgeText = qualifier ? `${label} · ${qualifier}` : label;
  const reasonCode = typeof reason?.code === "string" ? reason.code : null;
  const reasonLabel = reasonCode
    ? (REASON_LABELS[reasonCode] ?? reasonCode.replace(/[-_]/g, " "))
    : facts.wait && facts.wait !== "none"
      ? `Waiting (${String(facts.wait).replace(/[-_]/g, " ")})`
      : "Normal operation";
  const reasonDetail =
    typeof reason?.detail === "string"
      ? reason.detail
      : facts.wait === "timer"
        ? "Waiting for the task's timer without holding an execution slot."
        : null;
  const allowedActions = Array.isArray(itemRec.allowed_actions)
    ? itemRec.allowed_actions.map(String)
    : [];
  const hasResult = Boolean(facts.has_result) || Boolean(resultRec);
  const resultAccessNotice = !allowedActions.includes("result")
    ? hasResult
      ? "Result exists, but current policy or session authority does not permit reading the payload."
      : "No result yet while work is in progress."
    : null;

  return {
    work_id: String(itemRec.work_id ?? itemRec.id ?? ""),
    workflow_id: typeof itemRec.workflow_id === "string" ? itemRec.workflow_id : null,
    title: String(itemRec.title ?? itemRec.action ?? itemRec.work_id ?? "Task"),
    revision: typeof itemRec.revision === "number" ? itemRec.revision : null,
    state: normalized,
    label,
    qualifier,
    badgeText,
    logicalOutcome: String(facts.coordinator ?? normalized),
    physicalCessation: physical,
    effectCertainty: effect,
    stopRequested,
    validationState: checksFailed ? "failed" : normalized === "completed" ? "passed" : "not_run",
    validationFailures,
    reasonCode,
    reasonLabel,
    reasonDetail,
    allowedActions,
    hasResult,
    resultAccessNotice,
  };
}

export function formatCliWorkItemHuman(item: object, result?: object | null): string {
  const p = presentCliWorkItem(item, result);
  const lines = [
    `${p.title} (${p.work_id})`,
    `State: ${p.badgeText}`,
    `Logical / Physical / Effect: ${p.logicalOutcome} / ${p.physicalCessation} / ${p.effectCertainty}`,
  ];
  if (p.revision !== null) lines.push(`Revision: ${p.revision}`);
  if (p.reasonCode || p.reasonDetail) {
    lines.push(`Reason: ${p.reasonLabel}${p.reasonDetail ? ` — ${p.reasonDetail}` : ""}`);
  }
  if (p.validationFailures.length > 0) {
    lines.push(`Validation failures: ${p.validationFailures.join("; ")}`);
  }
  if (p.allowedActions.length > 0) {
    lines.push(`Permitted actions: ${p.allowedActions.join(", ")}`);
  }
  if (p.resultAccessNotice) {
    lines.push(`Result notice: ${p.resultAccessNotice}`);
  }
  return lines.join("\n");
}

export function formatCliWorkResultHuman(result: object, item?: object | null): string {
  const resultRec = toRecord(result);
  const itemRec = toRecord(item);
  const workId = String(resultRec.work_id ?? itemRec.work_id ?? "");
  const status = String(resultRec.status ?? "pending");
  const outcome =
    resultRec.outcome && typeof resultRec.outcome === "object" ? toRecord(resultRec.outcome) : null;
  const failures = extractCliValidationFailures(itemRec, resultRec);
  const lines = [`Work result: ${workId} (${status})`];
  if (!outcome) {
    lines.push("Outcome: No result yet while work is in progress.");
  } else if (outcome.ok) {
    lines.push(failures.length > 0 ? "Outcome: Completed · checks failed" : "Outcome: Completed");
    lines.push(
      `Value: ${typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value)}`,
    );
  } else {
    const errorObj =
      outcome.error && typeof outcome.error === "object" ? toRecord(outcome.error) : {};
    lines.push(
      `Outcome: ${errorObj.code === "Cancelled" ? "Cancelled" : "Failed"} (${String(errorObj.code ?? "Error")}): ${String(errorObj.message ?? "Execution failed")}`,
    );
  }
  if (failures.length > 0) {
    lines.push(`Validation failures: ${failures.join("; ")}`);
  }
  return lines.join("\n");
}

export function isRefusedOperatorSubmission(error: unknown, submittedToNetwork: boolean): boolean {
  if (!submittedToNetwork) return true;
  if (!error || typeof error !== "object") return false;
  const disp = (error as WorkCliError).admissionDisposition;
  return disp === "not-accepted" || disp === "refused";
}

export function isRefusedOperatorStop(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as WorkCliError;
  if (err.stopDisposition === "refused" || err.stopDisposition === "not-accepted") return true;
  if (
    err.status === 409 &&
    (err.code === "WorkRevisionConflict" || err.code === "WorkStopUnavailable")
  )
    return true;
  if (err.status === 404 && err.code === "WorkNotFound") return true;
  if (
    err.status === 403 &&
    (err.code === "Forbidden" || err.code === "WorkReadDenied" || err.code === "WorkControlDenied")
  )
    return true;
  return false;
}

function operator(): void {
  if (currentTarget().kind !== "system") {
    throw new Error(
      "This operator work command is unavailable in an identity CLI. Use identity-authorized work APIs.",
    );
  }
}

export async function callWork(path: string, body?: unknown): Promise<unknown> {
  operator();
  const secret =
    process.env.BARRY_SECRET ?? (await installationSecrets(["BARRY_SECRET"])).BARRY_SECRET;
  if (!secret) throw new Error("BARRY_SECRET is required for operator work commands.");
  let response: Response;
  try {
    response = await fetch(`${serviceAddress("workflows.runtime")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      transportFailed: true,
    } satisfies Partial<WorkCliError>);
  }
  const value = (await response.json()) as {
    code?: string;
    error?: string;
    message?: string;
    admission_disposition?: string;
    stop_disposition?: string;
    retryable?: boolean;
  };
  if (!response.ok) {
    throw Object.assign(
      new Error(value.message ?? value.error ?? `Work request failed (${response.status})`),
      {
        status: response.status,
        code: value.code,
        admissionDisposition: value.admission_disposition,
        stopDisposition: value.stop_disposition,
        retryable: value.retryable,
      } satisfies Partial<WorkCliError>,
    );
  }
  return value;
}

export async function waitForOperatorWork(
  id: string,
  options: { timeoutMs?: number; pollMs?: number; untilCeased?: boolean } = {},
): Promise<Record<string, unknown>> {
  operator();
  const workId = ref.parse(id);
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(600_000)
    .parse(options.timeoutMs ?? 30_000);
  const pollMs = z
    .number()
    .int()
    .min(25)
    .max(10_000)
    .parse(options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> | undefined;
  while (Date.now() <= deadline) {
    latest = (await callWork(`/api/v2/work/${encodeURIComponent(workId)}`)) as Record<
      string,
      unknown
    >;
    const state = String(latest.state ?? "");
    const physical = String((latest.facts as { physical?: string } | undefined)?.physical ?? "");
    const settledState = [
      "completed",
      "failed",
      "cancelled",
      "needs-attention",
      "waiting-for-approval",
    ].includes(state);
    const settledCessation =
      !options.untilCeased ||
      physical === "ceased" ||
      physical === "not-started" ||
      state === "needs-attention";
    if (settledState && settledCessation) return latest;
    if (Date.now() + pollMs > deadline) break;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, pollMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for work ${workId} (last state: ${String(latest?.state ?? "unknown")}).`,
  );
}

export async function startOperatorWork(
  reference: string,
  options: {
    inputJson: string;
    kind?: string;
    traits?: string;
    version?: string;
    key?: string;
    delegationKeys?: string;
    recoveryEpoch?: string;
  },
  report: (message: string) => void = console.error,
) {
  operator();
  const kind = z.enum(["workflow", "job", "action"]).parse(options.kind ?? "workflow");
  if (kind === "action")
    z.string()
      .regex(/^[^:@]+:[^:@]+$/)
      .parse(reference);
  if (kind === "job") {
    z.string()
      .regex(/^[a-z0-9._-]+:[a-z0-9._-]+@[1-9][0-9]*$/i)
      .parse(reference);
    if (options.version !== undefined && options.version !== "1") {
      throw new Error(
        "Jobs use the full versioned task reference; --version selects workflow versions only.",
      );
    }
  }
  const inputs: unknown = JSON.parse(options.inputJson);
  const recoveryEpoch =
    options.recoveryEpoch === undefined ? undefined : z.uuid().parse(options.recoveryEpoch);
  const parsed = z.json().parse(inputs);
  const key = ref.parse(
    options.key ?? (recoveryEpoch ? `${recoveryEpoch}:${randomUUID()}` : randomUUID()),
  );
  if (recoveryEpoch && !key.startsWith(`${recoveryEpoch}:`)) {
    throw new Error(
      "A post-restore invocation needs a new key prefixed with its recovery epoch. Do not replace an unconfirmed old key.",
    );
  }
  const path = options.delegationKeys ?? process.env.BARRY_WORKFLOW_DELEGATION_KEYS;
  if (!path) {
    throw new Error(
      "Operator work submission needs a dedicated workflows.cli.operator key in --delegation-keys or BARRY_WORKFLOW_DELEGATION_KEYS. The owner must trust that issuer.",
    );
  }
  const keysPath = resolve(path);
  const signingKey = () => {
    const selected = workDelegationSigningKey(readWorkDelegationKeys(keysPath)[issuerName] ?? []);
    if (!selected)
      throw new Error("No active workflows.cli.operator delegation key is configured.");
    return selected;
  };
  signingKey();
  const registry = installationRegistry();
  const metadata = (await callWork("/api/metadata")) as { installation: string };
  if (metadata.installation !== registry.id) {
    throw new Error(
      "The workflow service belongs to another installation. Refusing to transfer operator authority.",
    );
  }
  const definition =
    kind === "job"
      ? { kind, reference: ref.parse(reference) }
      : kind === "action"
        ? {
            kind,
            reference: ref.parse(reference),
            catalog_namespace: reference.slice(0, reference.indexOf(":")),
          }
        : { kind, reference: ref.parse(reference), version: ref.parse(options.version ?? "1") };
  const request = {
    ...(recoveryEpoch ? { recovery_epoch: recoveryEpoch } : {}),
    version: 2 as const,
    request_id: randomUUID(),
    idempotency_key: key,
    definition,
    inputs: parsed,
    origin: { entry_point: "work-cli", trigger: "manual" as const },
  };
  const selectedTraits =
    kind === "action"
      ? (options.traits ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
  const callerBounds = selectedTraits.length
    ? await (async () => {
        const [{ collectToolDefinitions }, { bounds }] = await Promise.all([
          import("@barry-rocks/sdk/internal/tools"),
          import("@barry-rocks/identities-bag"),
        ]);
        return approveWorkflowBounds({
          bags: selectedTraits,
          traitNames: selectedTraits,
          traits: Object.fromEntries(
            (await bounds.list()).filter((b) => b.name).map((b) => [b.name!, { bound: b }]),
          ),
          tools: await collectToolDefinitions(),
          bounds: [],
          boundByName: (name) => bounds.get(name),
        });
      })()
    : await approveWorkflowBounds({
        bags: [],
        tools: [],
        bounds: [],
        boundByName: async () => undefined,
      });
  const authority: WorkAuthority = {
    namespace: {
      installation: registry.id,
      principal_kind: "operator",
      principal_id: "local-operator",
      identity_id: null,
      caller_session_id: null,
    },
    run_identity: null,
    origin: request.origin,
    caller_ceiling: callerBounds,
  };
  const issuer = new WorkDelegationIssuer({
    path: join(bagDataDir("cli"), "work-operator-issuer.db"),
    issuer: issuerName,
    signingKey,
  });
  let submittedToNetwork = false;
  try {
    const prepared = issuer.prepare(request, authority, {
      kind: "operator",
      definition_owner_session: null,
      background_parent: false,
    });
    const delegation = issuer.issue(prepared.request, authority);
    report(`Submission key: ${key}`);
    submittedToNetwork = true;
    const value = (await callWork("/api/v2/work/submissions", {
      request: prepared.request,
      delegation,
    })) as { work: import("@barry-rocks/sdk/internal/workflows").WorkAdmission };
    return {
      work_id: value.work.work_id,
      workflow_id: value.work.workflow_id,
      idempotency_key: key,
      state: projectWorkState(value.work.facts).state,
    };
  } catch (error) {
    if (isRefusedOperatorSubmission(error, submittedToNetwork)) {
      const err = error as WorkCliError;
      throw Object.assign(
        new Error(
          `Submission was refused before acceptance: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { code: err?.code, status: err?.status, admissionDisposition: err?.admissionDisposition },
      );
    }
    throw new Error(
      `Submission was not confirmed. Check with barry work lookup ${JSON.stringify(key)}; retry this same key and input. ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    issuer.close();
  }
}

export function registerWork(program: Command): void {
  const work = program
    .command("work")
    .description("Start and inspect durable background work as the local operator");
  work.hook("preAction", (_root, command) => {
    if (command.optsWithGlobals().identity !== undefined) {
      throw new Error(
        "Operator work commands cannot use --identity. Use identity-authorized work APIs.",
      );
    }
  });
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  work
    .command("recovery")
    .description("Inspect the restore recovery point and admission activation state")
    .option("--json", "Output as JSON")
    .action(async () => print(await callWork("/api/v2/recovery")));

  work
    .command("activate-admission")
    .description("Audit activation for new invocations; existing runs stay paused")
    .requiredOption("--epoch <uuid>", "Inspected recovery epoch")
    .requiredOption("--reason <reason>", "Evidence supporting activation")
    .requiredOption("--residual-risk <risk>", "Remaining recovery-gap risk accepted")
    .requiredOption(
      "--effect-paths-fenced",
      "Attest all prior owner/executor/broker effect paths are fenced",
    )
    .requiredOption(
      "--post-snapshot-work-reviewed",
      "Attest surviving receipts and post-snapshot effects were reviewed",
    )
    .option("--request-id <uuid>", "Reuse this UUID and inputs after an unconfirmed reply")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        epoch: string;
        reason: string;
        residualRisk: string;
        effectPathsFenced: boolean;
        postSnapshotWorkReviewed: boolean;
        requestId?: string;
      }) => {
        const body = recoveryActivationSchema.parse({
          request_id: options.requestId ?? randomUUID(),
          expected_epoch: options.epoch,
          reason: options.reason,
          residual_risk: options.residualRisk,
          effect_paths_fenced: options.effectPathsFenced,
          post_snapshot_work_reviewed: options.postSnapshotWorkReviewed,
        });
        console.error(`Recovery activation request ID: ${body.request_id}`);
        try {
          print(await callWork("/api/v2/recovery/activate", body));
        } catch (error) {
          throw new Error(
            `Activation reply not confirmed. Inspect work recovery and retry the same inputs and --request-id ${body.request_id}. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

  work
    .command("list", { isDefault: true })
    .option("--states <states>", "Comma-separated canonical states")
    .option(
      "--trigger <trigger>",
      "Filter by trigger: invocation, schedule, event, internal, manual",
    )
    .option("--kind <kind>", "Filter by definition kind: action, job, workflow")
    .option("--reference <ref>", "Filter by definition reference")
    .option("--limit <n>", "Maximum items per page")
    .option("--cursor <cursor>", "Continue the same filtered page")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        states?: string;
        trigger?: string;
        kind?: string;
        reference?: string;
        limit?: string;
        cursor?: string;
        human?: boolean;
      }) => {
        const query = new URLSearchParams();
        if (options.states) query.set("states", options.states);
        if (options.trigger) query.set("trigger", options.trigger);
        if (options.kind) query.set("definition_kind", options.kind);
        if (options.reference) query.set("definition_ref", options.reference);
        if (options.limit) query.set("limit", options.limit);
        if (options.cursor) query.set("cursor", options.cursor);
        const response = (await callWork(`/api/v2/work?${query}`)) as {
          items?: Record<string, unknown>[];
        };
        if (options.human && Array.isArray(response?.items)) {
          if (response.items.length === 0) {
            console.log("No background work items matched.");
            return;
          }
          console.log(response.items.map((item) => formatCliWorkItemHuman(item)).join("\n\n"));
          return;
        }
        print(response);
      },
    );

  work
    .command("show <id>")
    .description("Read current status and permitted actions")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: { human?: boolean }) => {
      const item = (await callWork(`/api/v2/work/${encodeURIComponent(ref.parse(id))}`)) as Record<
        string,
        unknown
      >;
      if (options.human) {
        console.log(formatCliWorkItemHuman(item));
        return;
      }
      print(item);
    });

  work
    .command("result <id>")
    .description("Read the final outcome and retained partial output")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: { human?: boolean }) => {
      const result = (await callWork(
        `/api/v2/work/${encodeURIComponent(ref.parse(id))}/result`,
      )) as Record<string, unknown>;
      if (options.human) {
        console.log(formatCliWorkResultHuman(result));
        return;
      }
      print(result);
    });

  work
    .command("wait <id>")
    .description("Wait until durable work reaches a terminal or decision-needed state")
    .option("--timeout-ms <ms>", "Maximum time to wait in milliseconds", "30000")
    .option("--poll-ms <ms>", "Poll interval in milliseconds", "250")
    .option("--until-ceased", "Wait until physical execution cessation is also confirmed")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        options: { timeoutMs?: string; pollMs?: string; untilCeased?: boolean; human?: boolean },
      ) => {
        const item = await waitForOperatorWork(id, {
          timeoutMs: Number(options.timeoutMs ?? "30000"),
          pollMs: Number(options.pollMs ?? "250"),
          untilCeased: Boolean(options.untilCeased),
        });
        if (options.human) {
          console.log(formatCliWorkItemHuman(item));
          return;
        }
        print(item);
      },
    );

  work
    .command("lookup <key>")
    .description("Recover an accepted submission without resubmitting it")
    .option("--session <id>", "Disambiguate its originating session")
    .option("--json", "Output as JSON")
    .action(async (key: string, options: { session?: string }) => {
      const query = new URLSearchParams({ key: ref.parse(key) });
      if (options.session) query.set("session", ref.parse(options.session));
      print(await callWork(`/api/v2/work/operations?${query}`));
    });

  work
    .command("start <task>")
    .description("Submit a registered task; reuse --key and input after a lost reply")
    .requiredOption("--input-json <json>", "Task input as JSON")
    .option("--kind <kind>", "Registered definition kind: workflow, job or action", "workflow")
    .option(
      "--traits <names>",
      "Explicit comma-separated caller traits for an installed script action",
    )
    .option(
      "--version <version>",
      "Requested workflow version (jobs use the versioned task reference)",
      "1",
    )
    .option("--key <key>", "Stable invocation key (generated and printed if omitted)")
    .option("--delegation-keys <path>", "Local dedicated operator issuer key ring")
    .option(
      "--recovery-epoch <uuid>",
      "Explicit new post-restore invocation; generates a new epoch-prefixed key",
    )
    .option("--wait", "Wait for the submitted work item to settle before returning")
    .option("--timeout-ms <ms>", "Maximum wait time in milliseconds when --wait is set", "30000")
    .option("--json", "Output as JSON")
    .action(
      async (
        task: string,
        options: Parameters<typeof startOperatorWork>[1] & { wait?: boolean; timeoutMs?: string },
      ) => {
        const started = await startOperatorWork(task, options);
        if (options.wait) {
          const settled = await waitForOperatorWork(started.work_id, {
            timeoutMs: Number(options.timeoutMs ?? "30000"),
          });
          print({ ...started, state: String(settled.state ?? started.state), settled });
          return;
        }
        print(started);
      },
    );

  work
    .command("evidence <id>")
    .description("Review verified retained receipts and reconciliation audit")
    .option("--json", "Output as JSON")
    .action(async (id: string) =>
      print(await callWork(`/api/v2/work/${encodeURIComponent(ref.parse(id))}/reconciliation`)),
    );

  work
    .command("reconcile <id>")
    .description("Apply a reviewed retained receipt without launching again")
    .requiredOption("--revision <revision>", "Canonical revision from work evidence")
    .requiredOption("--attempt <id>", "Reviewed original attempt ID")
    .requiredOption("--receipt-digest <digest>", "Reviewed immutable receipt digest")
    .requiredOption("--reason <reason>", "Why this evidence resolves the blocking decision")
    .requiredOption("--residual-risk <risk>", "Remaining risk accepted by the operator")
    .option("--request-id <id>", "Reuse this UUID and all inputs after a lost reply")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        options: {
          revision: string;
          attempt: string;
          receiptDigest: string;
          reason: string;
          residualRisk: string;
          requestId?: string;
        },
      ) => {
        const body = workReconciliationSchema.parse({
          request_id: options.requestId ?? randomUUID(),
          expected_revision: Number(options.revision),
          attempt_id: options.attempt,
          receipt_digest: options.receiptDigest,
          reason: options.reason,
          residual_risk: options.residualRisk,
        });
        console.error(`Reconciliation request ID: ${body.request_id}`);
        try {
          print(
            await callWork(
              `/api/v2/work/${encodeURIComponent(ref.parse(id))}/reconciliation`,
              body,
            ),
          );
        } catch (error) {
          throw new Error(
            `Reconciliation reply was not confirmed. Inspect work evidence; retry with the same inputs and --request-id ${body.request_id}. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

  work
    .command("stop <id>")
    .description("Request stop at an inspected revision; acknowledgement does not prove cessation")
    .requiredOption("--revision <revision>", "Canonical revision from work show")
    .option("--request-id <id>", "Reuse this UUID after a lost stop reply")
    .option("--wait", "Wait until physical cessation is confirmed after requesting stop")
    .option("--timeout-ms <ms>", "Maximum wait time in milliseconds when --wait is set", "30000")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        options: { revision: string; requestId?: string; wait?: boolean; timeoutMs?: string },
      ) => {
        const body = {
          request_id: z.uuid().parse(options.requestId ?? randomUUID()),
          expected_revision: z.coerce.number().int().positive().parse(options.revision),
        };
        console.error(`Stop request ID: ${body.request_id}`);
        try {
          const ack = (await callWork(
            `/api/v2/work/${encodeURIComponent(ref.parse(id))}/stop`,
            body,
          )) as Record<string, unknown>;
          if (options.wait) {
            const settled = await waitForOperatorWork(id, {
              timeoutMs: Number(options.timeoutMs ?? "30000"),
              untilCeased: true,
            });
            print({ ...ack, settled });
            return;
          }
          print(ack);
        } catch (error) {
          if (isRefusedOperatorStop(error)) {
            const err = error as WorkCliError;
            if (err.code === "WorkRevisionConflict") {
              throw Object.assign(
                new Error(
                  `Stop refused because revision ${body.expected_revision} is stale. Inspect current state with barry work show ${id} before requesting Stop again. ${error instanceof Error ? error.message : String(error)}`,
                ),
                { code: err.code, status: err.status },
              );
            }
            throw Object.assign(
              new Error(
                `Stop refused before state change: ${error instanceof Error ? error.message : String(error)}`,
              ),
              { code: err.code, status: err.status },
            );
          }
          throw new Error(
            `Stop reply was not confirmed. Retry the same --revision and --request-id ${body.request_id}. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

  const executeWorkOps = (args: string[]) => {
    operator();
    let outcome: { result: unknown; exitCode: number };
    try {
      outcome = runWorkOps(args);
    } catch {
      process.exitCode = 1;
      throw new Error(
        "WorkOpsRefused: check arguments, sealed-copy provenance, paths and input schema. See sdk/docs/work-sessions-operations.md.",
      );
    }
    print(outcome.result);
    process.exitCode = outcome.exitCode;
  };

  const ops = work
    .command("ops")
    .description(
      "Inspect retained Work/Sessions inventory, verify local member files, and diagnose sealed database copies",
    );

  ops
    .command("inventory <spec>")
    .description("Inspect explicit local Work/Sessions roots without implying backup completeness")
    .option("--json", "Output as JSON")
    .action((spec: string) => {
      executeWorkOps(["inventory", spec]);
    });

  ops
    .command("verify-files <directory> <members>")
    .description("Verify local member digests without certifying custody closure")
    .option("--json", "Output as JSON")
    .action((directory: string, members: string) => {
      executeWorkOps(["verify-files", directory, members]);
    });

  ops
    .command("diagnose-sealed <role> <copy> <sha256>")
    .description("Run read-only offline diagnostics on a hash-verified sealed database copy")
    .option("--json", "Output as JSON")
    .action((role: string, copy: string, sha256: string) => {
      executeWorkOps(["diagnose-sealed", role, copy, sha256]);
    });
}
