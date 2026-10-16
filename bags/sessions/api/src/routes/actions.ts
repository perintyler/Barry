import {identityRecords} from "@barry-rocks/identities-bag";
import {Barry, isBarryError, requestCaller} from "@barry-rocks/sdk";
import {actionsRoutes} from "@barry-rocks/sdk/internal/routes";
import {serve} from "@barry-rocks/sdk/services/http";
import {sessionIdentity} from "@barry-rocks/sdk/stores";
import {createLogger} from "@barry-rocks/sdk/logging";
import {readProcessStartTime} from "@barry-rocks/sessions-bag/process-liveness";
import {Router, type Request, type Response} from "express";
import {actionWorkflowAuthority} from "../session-workflow-control.js";
import {startSessionWorkflowAgentAction, startSessionWorkflowAction, lookupSessionWorkflowAction, sessionWorkAdmissionRefused} from "../session-workflow-admission.js";
import {readSessionWorkflowWork, readSessionWorkflowWorkResult, stopSessionWorkflowWork, listSessionWorkflowSelections, sessionWorkflowCatalog, sessionWorkflowStopRefused} from "../session-workflow-read.js";
import {currentStoreContext} from "@barry-rocks/sdk/internal/stores";
import {WorkflowError} from "@barry-rocks/sdk/internal/workflows";
import {actionWorkflowLink, stopWorkflowAction, wantsWorkflowReference} from "./actions-work-control.js";
import {hostname} from "node:os";
import {z} from "zod";
// Action-run persistence belongs to the actions bag.
// See docs/decisions/0035-session-route-and-summary-rationale.md.
import {ActionRuns, AmbiguousActionError, BeginActionError, abandonOrphanedActionRuns, beginActionRun, resolveRunnableAction} from "@barry-rocks/actions-bag";
import type { ActionRunRecord } from "@barry-rocks/actions-bag";
import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import {findAction, listAllActions, validateActionInputs, renderActionInstruction} from "@barry-rocks/sdk/internal/actions";





import {expandCompositionFromSnapshot, loadBagRegistrySnapshot} from "@barry-rocks/sdk/internal/bags";
import {Processes, Sessions} from "@barry-rocks/sessions-bag/client";
import {validateRepoPath} from "../repo-paths.js";
import {runningAgents} from "./actions-executor-support.js";
import {executeDetached, stopDetachedRun} from "./actions-executor.js";
export { executeDetached, stopDetachedRun };
export type { DetachedRunRequest, DetachedRunResult } from "./actions-executor.js";

const log = createLogger("barry-server");

export const actionsRouter = Router();
const routes = serve(actionsRouter, "/actions");


// Snake_case on purpose — see the module doc comment.
/**
 * Query params for the runs listing. Coerced, because Express hands every
 * query value back as a string — `limit=10` must not fail a number check.
 */
const ListRunsQuerySchema = z.strictObject({
  session_id: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  status: z.enum(["started", "complete", "failed", "cancelled"]).optional(),
  schedule_id: z.string().min(1).optional(),
  trigger: z.enum(["session", "api", "cli", "schedule", "job"]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * GET /actions/runs/:id — read a recorded run back, output included.
 *
 * The reason this exists: before it, `output` was a write-only column. A run's
 * deliverable went into the store and no surface ever brought it out, so agents
 * kept restating the whole report in prose — the exact behaviour the output
 * column was added to stop (bags/actions/README.md). A stored deliverable nothing can
 * retrieve is indistinguishable from one that was never stored.
 *
 * `metadata` is returned here and NOWHERE ELSE. It carries the run's input
 * side — the inputs it was called with and the composed prompt — which is the
 * other half of the same problem `output` solved: a run whose deliverable can
 * be read but whose request cannot is only half observable. It stays off the
 * list response for the same reason outputs do (prompts are large, and fifty
 * of them is megabytes nobody asked for).
 *
 * Snake_case out, matching the POST sibling — see the module doc comment.
 */
/**
 * POST /actions/runs/:id/cancel -- stop a detached run's agent, then close its
 * row `cancelled` with the reason.
 *
 * 404 `not_running` when no agent is running for the id here: the run already
 * finished, was never a detached run, or the API restarted (which ended its
 * agent with it). The caller decides what to do with the row in that case.
 */
async function stopOwnedWork(req: Request, res: Response, owned: ActionRunRecord) {
  try {
    const ack = await stopWorkflowAction(owned, req.body, actionWorkflowAuthority(req, currentStoreContext()));
    return res.status(202).json(ack);
  } catch (error) {
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable,
      request_id: req.body?.request_id, workflow: actionWorkflowLink(owned) });
    return res.status(503).json({ error: "WorkStopUnknown", message: "Workflow Stop was not confirmed; preserve its request ID, revision and reason.", request_id: req.body?.request_id, retryable: true });
  }
}

routes.route(actionsRoutes.listWorkflowWorkSessions, async (req, res) => {
  if (!actionsRoutes.listWorkflowWorkSessions.query.safeParse(req.query).success) return res.status(422).json({ error: "InvalidInputs", message: "The owned-session picker does not accept partition overrides." });
  try { return res.json(await listSessionWorkflowSelections(req.authPrincipal)); }
  catch (error) {
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable });
    return res.status(503).json({ error: "WorkReadUnknown", message: "Owned workflow sessions are unavailable.", retryable: true });
  }
});
routes.route(actionsRoutes.getWorkflowWorkCatalog, async (req, res) => {
  const selection = actionsRoutes.getWorkflowWorkCatalog.query.safeParse(req.query);
  if (!selection.success) return res.status(422).json({ error: "InvalidInputs", message: "An explicit session_id is required for the selected workflow catalog." });
  try { return res.json(await sessionWorkflowCatalog(selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity)); }
  catch (error) {
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable });
    return res.status(503).json({ error: "WorkReadUnknown", message: "Selected workflow catalog is unavailable.", retryable: true });
  }
});

for (const [declaration, read] of [
  [actionsRoutes.getSessionWorkflowWork, readSessionWorkflowWork],
  [actionsRoutes.getSessionWorkflowWorkResult, readSessionWorkflowWorkResult],
] as const) {
  routes.route(declaration, async (req, res) => {
    const selection = declaration.query.safeParse(req.query), params = declaration.params.safeParse(req.params);
    if (!selection.success || !params.success) return res.status(422).json({ error: "InvalidInputs", message: "Canonical work reads require an explicit session_id and work ID." });
    try { return res.json(await read(params.data.id, selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity)); }
    catch (error) {
      if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable });
      return res.status(503).json({ error: "WorkReadUnknown", message: "Workflow inspection is unavailable; preserve the selected session and work ID.", retryable: true });
    }
  });
}
routes.route(actionsRoutes.stopSessionWorkflowWork, async (req, res) => {
  const declaration = actionsRoutes.stopSessionWorkflowWork, selection = declaration.query.safeParse(req.query), params = declaration.params.safeParse(req.params), body = declaration.body.safeParse(req.body);
  if (!selection.success || !params.success || !body.success) return res.status(422).json({ error: "InvalidInputs", message: "Canonical workflow Stop requires an explicit session, work ID, request ID, revision and reason.", stop_disposition: "refused" });
  try { return res.status(202).json(await stopSessionWorkflowWork(params.data.id, body.data, selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity)); }
  catch (error) {
    const disposition = sessionWorkflowStopRefused(error) ? { stop_disposition: "refused" as const } : {};
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable, ...disposition });
    return res.status(503).json({ error: "WorkStopUnknown", message: "Workflow Stop is unconfirmed; preserve the selected session, work ID, request ID, revision and reason.", retryable: true, ...disposition });
  }
});

routes.route(actionsRoutes.startSessionWorkflowAction, async (req, res) => {
  const selection = actionsRoutes.startSessionWorkflowAction.query.safeParse(req.query);
  const body = actionsRoutes.startSessionWorkflowAction.body.safeParse(req.body);
  const params = actionsRoutes.startSessionWorkflowAction.params.safeParse(req.params);
  if (!selection.success || !body.success || !params.success) return res.status(422).json({ error: "InvalidInputs", message: "Workflow admission requires an explicit session, stable request ID, key and inputs.", admission_disposition: "refused" });
  try {
    const ack = await startSessionWorkflowAction(req.params.name, body.data, selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity);
    return res.status(ack.created ? 201 : 200).json(ack);
  } catch (error) {
    const disposition = sessionWorkAdmissionRefused(error) ? { admission_disposition: "refused" as const } : {};
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable, ...disposition });
    return res.status(503).json({ error: "WorkAdmissionUnknown", message: "Admission is unconfirmed; preserve the original session, key and inputs for lookup or retry.", retryable: true, ...disposition });
  }
});

routes.route(actionsRoutes.startSessionWorkflowAgentAction, async (req, res) => {
  const selection = actionsRoutes.startSessionWorkflowAgentAction.query.safeParse(req.query);
  const body = actionsRoutes.startSessionWorkflowAgentAction.body.safeParse(req.body);
  const params = actionsRoutes.startSessionWorkflowAgentAction.params.safeParse(req.params);
  if (!selection.success || !body.success || !params.success) return res.status(422).json({ error: "InvalidInputs", message: "Workflow admission requires an explicit session, stable request ID, key and inputs.", admission_disposition: "refused" });
  try {
    const ack = await startSessionWorkflowAgentAction(req.params.name, body.data, selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity);
    return res.status(ack.created ? 201 : 200).json(ack);
  } catch (error) {
    const disposition = sessionWorkAdmissionRefused(error) ? { admission_disposition: "refused" as const } : {};
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable, ...disposition });
    return res.status(503).json({ error: "WorkAdmissionUnknown", message: "Admission is unconfirmed; preserve the original session, key and inputs for lookup or retry.", retryable: true, ...disposition });
  }
});

routes.route(actionsRoutes.lookupSessionWorkflowAction, async (req, res) => {
  const selection = actionsRoutes.lookupSessionWorkflowAction.query.safeParse(req.query);
  if (!selection.success) return res.status(422).json({ error: "InvalidInputs", message: "Operation lookup requires an explicit session." });
  try { return res.json(await lookupSessionWorkflowAction(req.params.key, selection.data.session_id, req.authPrincipal, currentStoreContext()?.identity)); }
  catch (error) {
    if (error instanceof WorkflowError) return res.status(error.status).json({ error: error.code, message: error.message, retryable: error.retryable });
    return res.status(503).json({ error: "WorkLookupUnknown", message: "Operation lookup is unconfirmed; preserve the original key and inputs.", retryable: true });
  }
});

routes.route(actionsRoutes.stopSessionWorkflowAction, async (req, res) => {
  const selected = actionsRoutes.stopSessionWorkflowAction.query.safeParse(req.query);
  if (!selected.success) return res.status(422).json({ error: "InvalidInputs", message: "An explicit session_id is required for session workflow Stop." });
  const owned = await ActionRuns.get(req.params.id);
  if (!owned?.workflow) return res.status(owned ? 409 : 404).json({ error: owned ? "ActionIsLegacy" : "unknown_run" });
  return stopOwnedWork(req, res, owned);
});

routes.route(actionsRoutes.stopWorkflowAction, async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    return res.status(422).json({ error: "invalid_inputs", details: ["reason: required"] });
  }
  const owned = await ActionRuns.get(req.params.id);
  if (owned?.workflow) {
    return stopOwnedWork(req, res, owned);
  }
  if (req.body?.request_id !== undefined || req.body?.expected_revision !== undefined) {
    return res.status(owned ? 409 : 404).json({ error: owned ? "ActionIsLegacy" : "unknown_run", message: "Workflow Stop cannot control a legacy run." });
  }
  const stop = runningAgents.get(req.params.id);
  if (!stop) {
    return res.status(404).json({ error: "not_running" });
  }
  stop(reason);
  try {
    const run = await ActionRuns.cancel(req.params.id, reason);
    return res.status(200).json({
      run_id: req.params.id,
      // null only if the row had already left `started` some other way (an
      // orphan sweep); the agent is stopped regardless.
      status: run?.status ?? null,
      agent_stopped: true,
    });
  } catch (err) {
    // The agent is already stopped; only the row write failed. Say both.
    return res.status(500).json({
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
      agent_stopped: true,
    });
  }
});

routes.route(actionsRoutes.getActionRun, async (req, res) => {
  await abandonOrphanedActionRuns(req.params.runId).catch(() => {});
  let run = await ActionRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: "unknown_run" });
  }

  const rawWait = req.query.wait_s ?? req.query.wait;
  const waitS = rawWait !== undefined ? Number(rawWait) : undefined;
  if (waitS && Number.isFinite(waitS) && waitS > 0 && run.status === "started") {
    const deadline = Date.now() + Math.min(waitS, 600) * 1000;
    while (Date.now() < deadline && run.status === "started") {
      const sleepMs = Math.min(250, Math.max(50, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      await abandonOrphanedActionRuns(req.params.runId).catch(() => {});
      const next = await ActionRuns.get(req.params.runId);
      if (next) run = next;
    }
  }

  res.vary("Accept");
  return res.status(200).json({
    run_id: run.id,
    ...(run.workflow && wantsWorkflowReference(req.get("Accept")) ? { workflow: actionWorkflowLink(run) } : {}),
    action: run.action,
    bag: run.bag,
    session_id: run.session_id,
    status: run.status,
    summary: run.summary,
    started_at: run.started_at.toISOString(),
    completed_at: run.completed_at?.toISOString() ?? null,
    validated_at: run.validated_at?.toISOString() ?? null,
    // Always present, never conditional: a reader must be able to tell "this
    // run recorded no inputs" from "this endpoint does not report them".
    metadata: run.metadata,
    output: run.output,
    output_type: run.output_type,
    trigger: run.trigger,
    schedule_id: run.schedule_id,
    process: run.process,
    ...(run.validation_failures ? { validation_failures: run.validation_failures } : {}),
  });
});

/** One catalog row. Shared by both paths so scoped and unscoped cannot drift. */
function toCatalogEntry(action: ActionMeta) {
  return {
    name: action.name,
    qualified_name: action.qualifiedName,
    bag: action.bag,
    description: action.description,
    executable: action.context === "none" && Boolean(action.outputSchema),
    // Kept alongside `input_schema` rather than replaced: a shipped
    // BarryActions that predates the form reads this, and dropping it would
    // make a client update a deploy-ordering problem for no gain. New
    // clients should read the schema.
    input_names: action.inputSchema
      ? Object.keys((action.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      : [],
    // The whole schema, so a GUI can build a real form — types, titles,
    // defaults, suggestions and per-field inference guidance. Flattening to
    // names was why the trigger sheet could only list what an action wanted
    // and let a free-text box carry it.
    ...(action.inputSchema ? { input_schema: action.inputSchema } : {}),
  };
}

/** Expand the identity's composed actions and report resolution scope; see docs/decisions/0020-session-route-and-cache-invariants.md. */
routes.route(actionsRoutes.listActions, async (req, res) => {
  if (req.query.session_id !== undefined) {
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    const identity = sessionIdentity(sessionId);
    if (!identity) return res.status(404).json({ error: "session_not_found", message: `Session ${sessionId} could not be placed` });
    try {
      const caller = Barry.as(requestCaller(req.authPrincipal));
      const owner = await caller.identity(identity).get();
      const bagNames = await expandCompositionFromSnapshot(owner.bags);
      const actions = await caller.identity(identity).session(sessionId).actions();
      return res.json({
        count: actions.length,
        actions: actions.map(action => ({
          name: action.name, qualified_name: action.qualifiedName, bag: action.bag,
          description: action.description, executable: action.executable, input_names: [...action.inputs],
          ...(action.inputSchema ? { input_schema: action.inputSchema } : {}),
        })),
        scope: { kind: "identity", identity: owner.name, bags: bagNames },
      });
    } catch (error) {
      if (!isBarryError(error)) throw error;
      return res.status(error.status).json({ error: error.reason, message: error.message });
    }
  }

  // Resolved exactly as POST /actions/trigger resolves it, so the catalog
  // lists what the trigger would actually run. Two different resolutions here
  // would mean offering an action the very next call refuses.
  let bagNames: string[] | null = null;
  let identityName: string | null = null;
  try {
    const resolved = await identityRecords.resolve({ repoPath: null }, requestCaller(req.authPrincipal));
    identityName = resolved.barry.name ?? null;
    const packed = identityRecords.config(resolved.barry).bags;
    bagNames = await expandCompositionFromSnapshot(packed);
  } catch (err) {
    // Deliberately not fatal, and deliberately not silent: no user to resolve
    // for, no identity resolved for it, or resolution broke. Falling back to
    // the full catalog keeps a trigger UI usable; `scope.kind: "all"` is what
    // stops that fallback from looking like a healthy scoped result, and this
    // is the server-side trace for a caller that does not read it.
    log.warn("actions.catalog_identity_unresolved", {
      ...(isBarryError(err) ? { reason: err.reason } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
    bagNames = null;
  }

  const { bags } = await loadBagRegistrySnapshot();
  const actions = bagNames ? await listAllActions(bags, { bagNames }) : await listAllActions(bags);
  return res.status(200).json({
    count: actions.length,
    actions: actions.map(toCatalogEntry),
    scope: bagNames
      ? { kind: "identity" as const, identity: identityName, bags: bagNames }
      : { kind: "all" as const, identity: null, bags: [] },
  });
});

/**
 * POST /actions/trigger — start a session that runs an action.
 *
 * Registered BEFORE `/:name/run` because that route's `:name` is a wildcard
 * that would otherwise swallow this path.
 *
 * Why a session rather than the executor: the executor runs only
 * `context: none` actions, and `wrap-up` — the case this exists for — is
 * `context: session` by design, since it summarizes a conversation. So the
 * trigger creates one for it.
 *
 * The seeded prompt is an INSTRUCTION to call `begin_action`, not the action's
 * composed prompt. That is what makes the agent create the run row itself:
 * pasting the prompt would run the work with no row, and the open-run listing
 * (`list-action-runs`) would never see it. It also means exactly one row per
 * trigger — this route deliberately creates none of its own.
 */
routes.route(actionsRoutes.triggerAction, async (req, res) => {
  const parsed = actionsRoutes.triggerAction.body.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(422).json({
      error: "invalid_body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
  }
  const body = parsed.data;

  const action = await findAction((await loadBagRegistrySnapshot()).bags, body.action);
  if (!action) {
    return res.status(404).json({ error: "unknown_action" });
  }

  const repoPath = body.repo_path ?? process.cwd();
  const validated = validateRepoPath(repoPath);
  if (!validated.ok) {
    return res.status(400).json({ error: "invalid_repo_path", message: validated.error });
  }

  // Before creating the session, for the same reason begin_action checks before creating
  // the run row: a rejected call must leave nothing behind. A session created
  // here and then abandoned is a stray row with an agent that never starts.
  const inputErrors = validateActionInputs(action, body.inputs);
  if (inputErrors.length) {
    return res.status(422).json({ error: "invalid_inputs", details: inputErrors });
  }

  try {
    // Resolve an identity the same way POST /sessions does. A session with
    // no identity is accepted here, but the spawn path later PATCHes a
    // resolved id onto the row — and a file-based Barry's id is a NAME HASH
    // with no matching row, so the session would point at no identity and
    // quietly run without its traits, bags and credentials.
    // `identityRecords.rowId` syncs the cache row and returns an id that has one.
    const selection = await identityRecords.resolve({ repoPath: validated.path }, requestCaller(req.authPrincipal));
    const identityId = (await identityRecords.rowId(selection.barry)) ?? undefined;

    // The session is granted the action's own bag, matching what the detached
    // executor does: the bag's tools are what this action's prompt plausibly
    // calls. `actions` is granted too, because without begin_action the seeded
    // instruction is a dead reference.
    // Inert ON PURPOSE: this route hands the prompt BACK rather than sending it,
    // so the caller can subscribe to the session's socket before the agent emits
    // anything. `POST /sessions` with a `prompt` would start it here and lose that
    // first output — which is exactly why an inert create survived the removal of
    // the draft concept.
    const pinnedBound = await Barry.as(requestCaller(req.authPrincipal)).bound(identityId ?? null, []);
    const session = await Sessions.createInert({
      bags: [...new Set(["actions", action.bag])],
      bound: pinnedBound,
      ...(identityId !== undefined ? { identity_id: identityId } : {}),
      metadata: {
        working_directory: validated.path,
        name: `Action: ${action.qualifiedName}`,
        source: "actions-app",
        // Recorded for the same reason POST /sessions records it. The
        // spawn path re-resolves the identity and, when the row disagrees,
        // PATCHes `selection.barry.id` RAW — no `identityRecords.rowId` — which
        // for a file-based Barry is a name hash with no row. Writing the
        // source here makes the row already agree, so that branch never fires.
        barry_source: selection.source,
        action: action.qualifiedName,
        // The triggered session runs IN THIS PROCESS (the API drives it as an
        // SDK query), so the API's pid is the honest answer to "is it still
        // running?" — the same pair the detached executor records.
        //
        // Without it the row has no pid, classifyProcessLiveness returns
        // `unknown/no-pid`, and the reconciler — which skips `alive` and
        // `other-host` but NOT `no-pid` — rewrote the session to `pending`
        // while its agent was mid-tool-call. That is how a run that finished
        // in 221s looked like a session that had died: the work was fine, the
        // status was overwritten underneath it.
        hostname: hostname(),
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.model ? { model: body.model } : {}),
        // Recorded so a triggered session is auditable even if its agent never
        // reaches begin_action — without this the decisions would exist only
        // inside the seeded prompt text.
        ...(body.inputs && Object.keys(body.inputs).length ? { inputs: body.inputs } : {}),
      },
    });

    await Processes.recordStart({
      sessionId: session.id,
      pid: process.pid,
      pidStartedAt: readProcessStartTime(process.pid),
      hostname: hostname(),
      source: "api",
      appName: body.provider ?? "api",
    });

    return res.status(201).json({
      session_id: session.id,
      action: action.qualifiedName,
      // The caller POSTs this to /sessions/:id/message to spawn the agent.
      // Handing back the text rather than sending it keeps this route free of
      // the SDK manager, and lets the caller subscribe to the session's socket
      // BEFORE the agent starts so no early output is missed.
      prompt: renderActionInstruction(action, body.extra ?? "", body.inputs),
      executable: action.context === "none" && Boolean(action.outputSchema),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("actions.trigger_failed", { action: body.action, error: message });
    return res.status(500).json({ error: "trigger_failed", message });
  }
});

/**
 * GET /actions/runs — list recorded runs, newest first.
 *
 * Outputs are deliberately omitted: a listing of 50 wrap-up reports would be
 * megabytes of markdown nobody asked for. Callers fetch the one they want by
 * id, and `has_output` tells them which ids are worth fetching.
 */
routes.route(actionsRoutes.listActionRuns, async (req, res) => {
  const parsed = ListRunsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    return res.status(422).json({
      error: "invalid_query",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`),
    });
  }
  const { session_id, action, status, schedule_id, trigger, limit } = parsed.data;

  await abandonOrphanedActionRuns().catch(() => {});
  const runs = await ActionRuns.list({
    ...(session_id ? { session_id } : {}),
    ...(schedule_id ? { schedule_id } : {}),
    ...(trigger ? { trigger } : {}),
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(limit ? { limit } : {}),
  });

  res.vary("Accept");
  return res.status(200).json({
    count: runs.length,
    runs: runs.map((run) => ({
      run_id: run.id,
      ...(run.workflow && wantsWorkflowReference(req.get("Accept")) ? { workflow: actionWorkflowLink(run) } : {}),
      action: run.action,
      bag: run.bag,
      session_id: run.session_id,
      status: run.status,
      summary: run.summary,
      started_at: run.started_at.toISOString(),
      completed_at: run.completed_at?.toISOString() ?? null,
      has_output: run.output !== null,
      output_type: run.output_type,
      trigger: run.trigger,
      schedule_id: run.schedule_id,
      exit_code: run.process?.exit_code ?? null,
      duration_ms: run.process?.duration_ms ?? null,
    })),
  });
});

/**
 * POST /actions/:name/begin — start a run and hand back its prompt.
 *
 * The HTTP twin of the `begin_action` tool, through the same beginActionRun:
 * a bag's own code (via Platypus) can open a run it or its agent then works
 * and closes, recorded exactly as an agent-begun run would be. It does not do
 * the work — that is /:name/run. The run stays `started` until completed or
 * cancelled, like any other.
 *
 * Tool availability is unknown here, so requirement warnings are not computed
 * — the same "unknown means silent" rule an anonymous MCP session gets.
 */
routes.route(actionsRoutes.beginAction, async (req, res) => {
  const parsed = actionsRoutes.beginAction.body.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(422).json({
      error: "invalid_body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
  }
  try {
    const begun = await beginActionRun(req.params.name, parsed.data.inputs, {
      sessionId: parsed.data.session_id ?? null,
      availableTools: null,
    });
    return res.status(201).json(begun);
  } catch (err) {
    if (err instanceof BeginActionError) {
      switch (err.reason) {
        case "unknown_action":
          return res.status(404).json({ error: "unknown_action", message: err.message });
        case "ambiguous_action":
          return res.status(409).json({ error: "ambiguous_action", message: err.message });
        case "invalid_inputs":
          return res.status(422).json({ error: "invalid_inputs", details: err.details });
      }
    }
    log.error("actions.begin_failed", { action: req.params.name, error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "begin_failed", message: err instanceof Error ? err.message : String(err) });
  }
});


routes.route(actionsRoutes.runAction, async (req, res) => {
  const parsedBody = actionsRoutes.runAction.body.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(422).json({
      error: "invalid_inputs",
      details: parsedBody.error.issues.map(
        (i) => `${i.path.join(".") || "body"}: ${i.message}`,
      ),
    });
  }
  const body = parsedBody.data;

  try {
    const { bags: registeredBags } = await loadBagRegistrySnapshot();
    let action;
    try {
      action = await resolveRunnableAction(req.params.name, {
        callerSessionId: body.caller_session_id ?? null,
        bags: registeredBags,
      });
    } catch (err) {
      if (err instanceof AmbiguousActionError) {
        return res.status(409).json({ error: "ambiguous_action", message: err.message });
      }
      throw err;
    }
    if (!action) {
      return res.status(404).json({ error: "unknown_action" });
    }

    const result = await executeDetached(action, body, registeredBags, req.authPrincipal);
    return res.status(result.status).json(result.body);
  } catch (err) {
    log.error("actions.run_error", {
      action: req.params.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
