import { BarryApiError } from "./errors.js";
import { actionsRoutes } from "../routes/actions.js";

import type { ApiTransport, RequestOptions } from "./http.js";

/**
 * Actions: find them, start them in a session, or run a detachable one to
 * completion. The wire is snake_case (see actions/types.ts); this edge
 * is camelCase like the rest of the client.
 */

export interface ActionCatalogEntry {
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
  async catalog(options: RequestOptions & { sessionId?: string } = {}, request: RequestOptions = {}): Promise<{ actions: ActionCatalogEntry[]; scope: { kind: "identity" | "all"; identity: string | null; bags: string[] } }> {
    const { sessionId, ...controls } = options;
    const catalog = (await this.http.call(actionsRoutes.listActionCatalog, { query: { session_id: sessionId } }, { ...controls, ...request }))!;
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

  /** A recorded run with its output, or null when no run has this id. */
  async getRun(runId: string, request: RequestOptions = {}): Promise<ActionRun | null> {
    const run = await this.http.call(actionsRoutes.getActionRun, { params: { runId } }, { ...request, notFound: "null" });
    if (!run) return null;
    return {
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

  /** Recorded runs, newest first, without outputs. */
  async listRuns(options: { sessionId?: string; scheduleId?: string; action?: string; status?: "started" | "complete" | "failed"; trigger?: "session" | "api" | "cli" | "schedule" | "job"; limit?: number } = {}, request: RequestOptions = {}) {
    const page = (await this.http.call(actionsRoutes.listActionRuns, { query: { schedule_id: options.scheduleId, session_id: options.sessionId, action: options.action, status: options.status, trigger: options.trigger, limit: options.limit } }, { ...request }))!;
    return page.runs.map((r) => ({
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
