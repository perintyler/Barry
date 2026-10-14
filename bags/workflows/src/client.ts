import { serviceAddress } from "@barry-rocks/sdk/services";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";

export async function callWorkflows(path: string, body?: unknown): Promise<unknown> {
  const secret = process.env.BARRY_SECRET;
  if (!secret) throw new Error("BARRY_SECRET is required for workflows");
  const context = currentStoreContext();
  if (!context?.workflowActor) throw new Error("workflow tools require an engine-verified identity; use the operator console for local administration");
  const actor = await context.workflowActor(path, body);
  const response = await fetch(`${serviceAddress("workflows.runtime")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "X-Workflow-Actor": actor },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`workflow request failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
