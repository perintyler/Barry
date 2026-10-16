import type { ActionRunRecord } from "./action-runs.js";
/** Read-only public pointer. Retained payloads stay on the detail/result boundary. */
export function actionWorkflowView(run: ActionRunRecord) {
  const work = run.workflow;
  return work ? { work_id: work.work_id, workflow_id: work.workflow_id, owner: work.owner,
    revision: work.revision, state: work.state, current: work.projection_current } : undefined;
}
