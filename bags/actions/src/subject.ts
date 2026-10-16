import { Barry, BarryError, isBarryError, type Action, type ActionRun, type Actions, type Caller } from "@barry-rocks/sdk";
import { BarryApiError, BarryClient } from "@barry-rocks/sdk/internal/client";
import { instanceEnvValue, getServiceUrl } from "@barry-rocks/sdk/services";

import { listAllActions, type RunnableAction } from "@barry-rocks/sdk/internal/actions";
import { expandCompositionFromSnapshot, loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { AdhocActions } from "./adhoc-actions.js";
import { ActionRuns, type ActionRunRecord } from "./action-runs.js";
import { abandonOrphanedActionRuns } from "./orphaned-runs.js";

function allowed(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read or run actions");
}

function actionOf(action: RunnableAction): Action {
  return {
    name: action.name, qualifiedName: action.qualifiedName, bag: action.source === "bag" ? action.bag : "",
    description: action.description, executable: action.context === "none" && Boolean(action.outputSchema),
    inputs: Object.keys(action.inputSchema?.properties ?? {}),
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
  };
}

function runOf(run: ActionRunRecord): ActionRun {
  return {
    id: run.id, action: run.action, sessionId: run.session_id, summary: run.summary,
    status: run.workflow && !["completed", "failed", "cancelled"].includes(run.workflow.state) ? run.workflow.state as ActionRun["status"] :
      run.status === "started" ? "running" : run.status === "complete" ? "succeeded" : run.status,
    ...(run.workflow ? { work: { workId: run.workflow.work_id, workflowId: run.workflow.workflow_id, owner: run.workflow.owner,
      revision: run.workflow.revision, state: run.workflow.state, current: run.workflow.projection_current } } : {}),
    startedAt: run.started_at.toISOString(), endedAt: run.completed_at?.toISOString() ?? null,
    ...(run.output !== null ? { output: run.output } : {}),
    ...(run.status === "failed" && run.summary ? { error: run.summary } : {}),
  };
}

export const actions: Actions = {
  name: "actions",
  async list(caller) {
    allowed(caller);
    const { bags } = await loadBagRegistrySnapshot();
    return (await listAllActions(bags)).filter(action => !action.shadowed).map(actionOf);
  },
  async forSession(identity, sessionId, caller) {
    allowed(caller);
    const asked = Barry.as(caller);
    await asked.identity(identity).session(sessionId).get();
    const owner = await asked.identity(identity).get();
    const { bags } = await loadBagRegistrySnapshot();
    const bagNames = await expandCompositionFromSnapshot(owner.bags);
    return [...await AdhocActions.list(sessionId), ...await listAllActions(bags, { bagNames })]
      .filter(action => action.source !== "bag" || !action.shadowed).map(actionOf);
  },
  async run(name, inputs, options, caller) {
    allowed(caller);
    try {
      const secret = instanceEnvValue("BARRY_SECRET");
      if (!secret) throw new BarryError("unavailable", "This instance has no BARRY_SECRET, so its sessions API cannot be reached");
      const client = BarryClient.connect({ baseUrl: getServiceUrl("api"), secret });
      const result = await client.actions.run(name, {
        inputs, ...options, ...(caller.kind === "session" ? { callerSessionId: caller.sessionId } : {}),
      });
      const record = await ActionRuns.get(result.runId);
      if (!record) throw new BarryError("not_found", `Action run ${result.runId} is gone`);
      return runOf(record);
    } catch (error) {
      if (isBarryError(error)) throw error;
      if (!(error instanceof BarryApiError)) throw new BarryError("unavailable", error instanceof Error ? error.message : String(error));
      const reason = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
        : error.status === 409 ? "conflict" : error.status === 400 || error.status === 422 ? "invalid" : "unavailable";
      throw new BarryError(reason, error.message);
    }
  },
  async runs(query, caller) {
    allowed(caller);
    await abandonOrphanedActionRuns().catch(() => {});
    return (await ActionRuns.list({ action: query.action, schedule_id: query.schedule, limit: query.limit })).map(runOf);
  },
};
