import { BarryApiError } from "./errors.js";
import { actionsRoutes } from "../routes/actions.js";

import type { ActionWorkReference } from "../barry/types.js";
import type { ActionWorkflow, ActionWorkItem, ActionWorkResult, ActionWorkStopAck } from "../actions/types.js";
import type { ApiTransport, RequestOptions } from "./http.js";

/**
 * Actions: find them, start them in a session, or run a detachable one to
 * completion. The wire is snake_case (see actions/types.ts); this edge
 * is camelCase like the rest of the client.
 */

export interface ActionEntry {
  name: string;
  qualifiedName: string;
  bag: string;
  description: string;
  /** Runnable with `run` — `context: none` and an output schema. */
  executable: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface BegunActionRun {
  runId: string;
  action: string;
  /** Where the action's own scripts live; its prompt references them from here. */
  actionDir: string;
  prompt: string;
  warnings: string[];
  /** true/false when a preflight ran, "unknown" when it could not decide, absent when none is declared. */
  preflightPassed?: boolean | "unknown";
  willBeChecked: string[];
  /** The contract the run's output must satisfy at completion, snapshotted now. */
  expectedOutputSchema?: Record<string, unknown>;
  next: string;
}

export interface ActionRunResult {
  runId: string;
  status: "complete" | "failed";
  output: string;
  outputType: "json" | "text";
  validationFailures?: unknown[];
}

export interface ActionRun {
  work?: ActionWorkReference;
  runId: string;
  action: string;
  bag: string | null;
  sessionId: string | null;
  status: "started" | "complete" | "failed" | "cancelled";
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
  output: string | null;
  outputType: "json" | "text" | null;
  metadata: Record<string, unknown> | null;
}

/** Select an identity-backed session partition; the server revalidates its authority. */
export interface ActionRunRequest extends RequestOptions { sessionId?: string }
export interface ActionWorkflowAdmission { runId: string; workId: string; workflowId: string; idempotencyKey: string; created: boolean }

function selectedRequest(request: ActionRunRequest) {
  const { sessionId, ...controls } = request;
  if (sessionId !== undefined && !actionsRoutes.getActionRun.query.safeParse({ session_id: sessionId }).success)
    throw new BarryApiError("sessionId must be a nonempty session identifier of at most 500 characters", { status: null, code: "invalid_request" });
  return { sessionId, controls };
}

function selectedWorkRequest(workId: string, request: ActionRunRequest & { sessionId: string }) {
  const { sessionId, controls } = selectedRequest(request);
  const params = actionsRoutes.getSessionWorkflowWork.params.safeParse({ id: workId });
  const query = actionsRoutes.getSessionWorkflowWork.query.safeParse({ session_id: sessionId });
  if (!params.success || !query.success) throw new BarryApiError("Canonical workflow access requires a work ID and explicit selected session", { status: null, code: "invalid_request" });
  return { params: params.data, query: query.data, controls };
}

/** The server's ceiling for a detached run, in seconds. */
const MAX_RUN_S = 600;
const DEFAULT_RUN_S = 300;

export class Actions {
  private readonly http: ApiTransport;

  // A field, not a parameter property: strip-only type stripping cannot
  // transform those, and bundled bag code must load under plain Node.
  constructor(http: ApiTransport) {
    this.http = http;
  }

  /** Actions the active identity can run, and how that scope was decided. */
  async catalog(options: RequestOptions & { sessionId?: string } = {}, request: RequestOptions = {}): Promise<{ actions: ActionEntry[]; scope: { kind: "identity" | "all"; identity: string | null; bags: string[] } }> {
    const { sessionId, ...controls } = options;
    const catalog = (await this.http.call(actionsRoutes.listActions, { query: { session_id: sessionId } }, { ...controls, ...request }))!;
    return {
      actions: catalog.actions.map((a) => ({
        name: a.name,
        qualifiedName: a.qualified_name,
        bag: a.bag,
        description: a.description,
        executable: a.executable,
        ...(a.input_schema ? { inputSchema: a.input_schema } : {}),
      })),
      scope: catalog.scope ?? { kind: "all", identity: null, bags: [] },
    };
  }

  /**
   * Create a draft session for an action. Returns the prompt to send to that
   * session to start it — the agent then opens the run itself.
   */
  async trigger(
    action: string,
    options: { repoPath?: string; extra?: string; inputs?: Record<string, unknown>; provider?: string; model?: string } = {},
    request: RequestOptions = {},
  ): Promise<{ sessionId: string; action: string; prompt: string; executable: boolean }> {
    const started = (await this.http.call(actionsRoutes.triggerAction, { body: {
        action,
        ...(options.repoPath ? { repo_path: options.repoPath } : {}),
        ...(options.extra ? { extra: options.extra } : {}),
        ...(options.inputs ? { inputs: options.inputs } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
      } }, { ...request }))!;
    return { sessionId: started.session_id, action: started.action, prompt: started.prompt, executable: started.executable };
  }

  /**
   * Open a run and get its prompt, exactly as an agent's `begin_action` would.
   * Doing the work, and closing the run, is up to the caller — or to the
   * session it is attributed to.
   */
  async begin(name: string, options: { inputs?: Record<string, unknown>; sessionId?: string } = {}, request: RequestOptions = {}): Promise<BegunActionRun> {
    const begun = (await this.http.call(actionsRoutes.beginAction, { params: { name }, body: {
        ...(options.inputs ? { inputs: options.inputs } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      } }, { ...request }))!;
    return {
      runId: begun.run_id,
      action: begun.action,
      actionDir: begun.action_dir,
      prompt: begun.prompt,
      warnings: begun.warnings ?? [],
      ...(begun.preflight_passed === undefined ? {} : { preflightPassed: begun.preflight_passed }),
      willBeChecked: begun.will_be_checked ?? [],
      ...(begun.expected_output ? { expectedOutputSchema: begun.expected_output.schema } : {}),
      next: begun.next,
    };
  }

  /**
   * Run a detachable action to completion and return its output. Blocks for as
   * long as the run takes (up to `timeoutS`, at most 600).
   */
  async run(
    name: string,
    options: { inputs?: Record<string, unknown>; provider?: string; model?: string; timeoutS?: number; identity?: string | number; callerSessionId?: string } = {},
    request: RequestOptions = {},
  ): Promise<ActionRunResult> {
    const timeoutS = Math.min(options.timeoutS ?? DEFAULT_RUN_S, MAX_RUN_S);
    const result = (await this.http.call(actionsRoutes.runAction, { params: { name }, body: {
        ...(options.inputs ? { inputs: options.inputs } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.identity === undefined ? {} : typeof options.identity === "number" ? { identity_id: options.identity } : { identity: options.identity }),
        ...(options.callerSessionId ? { caller_session_id: options.callerSessionId } : {}),
        timeout_s: timeoutS,
      } }, { ...request, timeoutMs: request.timeoutMs ?? (timeoutS + 30) * 1000 }))!;
    if (result.status === "started" || result.run_id === null) throw new BarryApiError("Action is still running or has no recorded run", { status: 200, code: "malformed_response" });
    return {
      runId: result.run_id,
      status: result.status,
      output: result.output ?? result.summary ?? "",
      outputType: result.output_type ?? "text",
      ...(result.validation_failures ? { validationFailures: result.validation_failures } : {}),
    };
  }

  /** Explicit installed-work admission. Preserve this key and inputs after an unconfirmed reply. */
  async startWorkflowRun(name: string, input: { requestId: string; idempotencyKey: string; inputs: Record<string, unknown>; recoveryEpoch?: string }, request: ActionRunRequest & { sessionId: string }): Promise<ActionWorkflowAdmission> {
    const { sessionId, controls } = selectedRequest(request);
    const query = actionsRoutes.startSessionWorkflowAction.query.safeParse({ session_id: sessionId });
    const body = actionsRoutes.startSessionWorkflowAction.body.safeParse({ request_id: input.requestId, idempotency_key: input.idempotencyKey, inputs: input.inputs, ...(input.recoveryEpoch === undefined ? {} : { recovery_epoch: input.recoveryEpoch }) });
    if (!query.success || !body.success) throw new BarryApiError("Workflow admission requires an explicit session, UUID request ID, stable key and JSON inputs", { status: null, code: "invalid_request" });
    const intent = structuredClone(body.data);
    const ack = (await this.http.call(actionsRoutes.startSessionWorkflowAction, { params: { name }, query: query.data, body: intent }, controls))!;
    if (ack.idempotency_key !== body.data.idempotency_key) throw new BarryApiError("Admission acknowledgement differs from the original key. Preserve the same session, key and inputs for recovery.", { status: 202, code: "malformed_response" });
    return { runId: ack.run_id, workId: ack.work_id, workflowId: ack.workflow_id, idempotencyKey: ack.idempotency_key, created: ack.created };
  }

  /** Read accepted-key recovery. A missing result does not prove an in-flight submission cannot commit. */
  async lookupWorkflowRun(key: string, request: ActionRunRequest & { sessionId: string }): Promise<ActionWorkflowAdmission | null> {
    const { sessionId, controls } = selectedRequest(request), query = actionsRoutes.lookupSessionWorkflowAction.query.safeParse({ session_id: sessionId });
    if (!query.success) throw new BarryApiError("Workflow lookup requires an explicit session", { status: null, code: "invalid_request" });
    const ack = await this.http.call(actionsRoutes.lookupSessionWorkflowAction, { params: { key }, query: query.data }, { ...controls, notFound: "null" });
    if (!ack) return null;
    if (ack.idempotency_key !== key || ack.created) throw new BarryApiError("Operation lookup differs from the original key", { status: 200, code: "malformed_response" });
    return { runId: ack.run_id, workId: ack.work_id, workflowId: ack.workflow_id, idempotencyKey: ack.idempotency_key, created: false };
  }

  /** Inspect canonical identity work even while its Actions history projection is absent. */
  async getWorkflowWork(workId: string, request: ActionRunRequest & { sessionId: string }): Promise<ActionWorkItem> {
    const { params, query, controls } = selectedWorkRequest(workId, request);
    const work = (await this.http.call(actionsRoutes.getSessionWorkflowWork, { params, query }, controls))!;
    if (work.work_id !== workId || work.namespace.principal_kind !== "identity" || work.namespace.identity_id !== work.namespace.principal_id)
      throw new BarryApiError("Canonical workflow response differs from the requested identity work", { status: 200, code: "malformed_response" });
    return work;
  }

  /** Fetch authorized canonical output; payload denials remain explicit failures. */
  async getWorkflowWorkResult(workId: string, request: ActionRunRequest & { sessionId: string }): Promise<ActionWorkResult> {
    const { params, query, controls } = selectedWorkRequest(workId, request);
    const result = (await this.http.call(actionsRoutes.getSessionWorkflowWorkResult, { params, query }, controls))!;
    if (result.work_id !== workId) throw new BarryApiError("Canonical workflow result differs from the requested work", { status: 200, code: "malformed_response" });
    return result;
  }

  /** Projection-independent Stop; acknowledgement does not establish physical cessation. */
  async stopWorkflowWork(workId: string, input: { reason: string; requestId: string; expectedRevision: number }, request: ActionRunRequest & { sessionId: string }): Promise<ActionWorkStopAck> {
    const { params, query, controls } = selectedWorkRequest(workId, request), body = actionsRoutes.stopSessionWorkflowWork.body.safeParse({
      reason: input.reason, request_id: input.requestId, expected_revision: input.expectedRevision,
    });
    if (!body.success) throw new BarryApiError("Workflow Stop requires the original request ID, revision and reason", { status: null, code: "invalid_request" });
    const intent = structuredClone(body.data);
    const ack = (await this.http.call(actionsRoutes.stopSessionWorkflowWork, { params, query, body: intent }, controls))!;
    if (ack.work_id !== workId || ack.request_id !== intent.request_id || ack.applied_revision < intent.expected_revision)
      throw new BarryApiError("Workflow Stop acknowledgement differs from its original intent; preserve the selected session, work ID, request ID, revision and reason", { status: 202, code: "malformed_response" });
    return ack;
  }

  /** A recorded run with its output, or null when no run has this id. */
  async getRun(runId: string, request: ActionRunRequest = {}): Promise<ActionRun | null> {
    const { sessionId, controls } = selectedRequest(request);
    const run = await this.http.call(actionsRoutes.getActionRun, { params: { runId }, query: { session_id: sessionId } }, { ...controls, responseProfile: "action-work-v1", notFound: "null" });
    if (!run) return null;
    return {
      ...(run.workflow ? { work: actionWorkReference(run.workflow) } : {}),
      runId: run.run_id,
      action: run.action,
      bag: run.bag,
      sessionId: run.session_id,
      status: knownStatus(run.status),
      summary: run.summary,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      output: run.output,
      outputType: run.output_type === "json" || run.output_type === "text" ? run.output_type : null,
      metadata: run.metadata ?? null,
    };
  }

  /** Request Stop from a workflow owner. This acknowledgement is not physical cessation. */
  async stopWorkflowRun(runId: string, input: { reason: string; requestId: string; expectedRevision: number }, request: ActionRunRequest = {}) {
    const { sessionId, controls } = selectedRequest(request), intent = { ...input };
    const current = await this.getRun(runId, { ...controls, sessionId });
    if (!current?.work?.current || current.work.stopProtocol !== "work-stop-v1")
      throw new BarryApiError("This server does not offer workflow Stop for the current run. Inspect Background work; no legacy cancellation was attempted.", { status: 409, code: "work_control_unsupported", detail: { stopRequestId: intent.requestId } });
    const ack = (await this.http.call(sessionId === undefined ? actionsRoutes.stopWorkflowAction : actionsRoutes.stopSessionWorkflowAction, { params: { id: runId }, ...(sessionId === undefined ? {} : { query: { session_id: sessionId } }), body: {
      reason: intent.reason, request_id: intent.requestId, expected_revision: intent.expectedRevision,
    } }, controls))!;
    if (ack.run_id !== runId || ack.work_id !== current.work.workId || ack.request_id !== intent.requestId || ack.applied_revision < intent.expectedRevision)
      throw new BarryApiError("Workflow Stop acknowledgement did not match this request. Preserve the request ID, revision and reason for recovery.", { status: 202, code: "malformed_response", detail: { stopRequestId: intent.requestId } });
    return { runId: ack.run_id, workId: ack.work_id, requestId: ack.request_id, appliedRevision: ack.applied_revision,
      stopRequested: ack.stop_requested, status: ack.status };
  }

  /** Recorded runs, newest first, without outputs. */
  async listRuns(options: { sessionId?: string; scheduleId?: string; action?: string; status?: "started" | "complete" | "failed"; trigger?: "session" | "api" | "cli" | "schedule" | "job"; limit?: number } = {}, request: RequestOptions = {}) {
    const page = (await this.http.call(actionsRoutes.listActionRuns, { query: { schedule_id: options.scheduleId, session_id: options.sessionId, action: options.action, status: options.status, trigger: options.trigger, limit: options.limit } }, { ...request, responseProfile: "action-work-v1" }))!;
    return page.runs.map((r) => ({
      ...(r.workflow ? { work: actionWorkReference(r.workflow) } : {}),
      runId: r.run_id,
      action: r.action,
      bag: r.bag,
      sessionId: r.session_id,
      status: knownStatus(r.status),
      summary: r.summary,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      hasOutput: r.has_output,
      outputType: r.output_type,
    }));
  }
}

function knownStatus(status: string): ActionRun["status"] {
  return status === "complete" || status === "failed" || status === "cancelled" ? status : "started";
}

function actionWorkReference(work: ActionWorkflow): ActionWorkReference {
  return { workId: work.work_id, workflowId: work.workflow_id, owner: work.owner, revision: work.revision,
    state: work.state, current: work.current, ...(work.stop_protocol ? { stopProtocol: work.stop_protocol } : {}), ...(work.url ? { url: work.url } : {}) };
}
