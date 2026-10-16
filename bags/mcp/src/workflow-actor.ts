import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { workflowActorSigner, type WorkflowActorContext } from "@barry-rocks/sdk/internal/auth";

/** Resolve signing credentials only when an authorized workflow call is made. */
export function installationWorkflowActor(execution: WorkflowActorContext): (path: string, body?: unknown) => Promise<string> {
  return async (path, body) => {
    const secrets = await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] });
    return workflowActorSigner(execution, secrets.BARRY_WORKFLOW_ACTOR_KEY)(path, body);
  };
}
