import type { Request } from "express";
import { z } from "zod";
import { assertToolAllowed, BoundSchema, approvedBoundsSchema, intersectWorkflowBounds, qualifyToolId, boundFingerprint, type ToolCallBounds } from "@barry-rocks/sdk/bounds";
import { workflowActorSigner, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import { WorkflowError } from "@barry-rocks/sdk/internal/workflows";
import type { StoreContext } from "@barry-rocks/sdk/internal/stores";
import { selectionOf } from "@barry-rocks/sessions-bag";
import { getSession } from "@barry-rocks/sessions-bag/client";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { requestSessionId } from "./request-authorization.js";
import { resolveWorkflowSessionBounds } from "./workflow-installed-bounds.js";

const retainedContext = z.strictObject({
  identity: z.string().min(1).optional(),
  bags: z.array(z.string()).optional(),
  traits: z.array(z.string()).optional(),
  bound: BoundSchema.nullable(),
  allowedToolIds: z.array(z.string()),
  harness: z.string().optional(),
});
function sessionBinding(row: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  return boundFingerprint({ id: row.id, state: row.state, ended_at: row.ended_at, user_id: row.user_id, identity_id: row.identity_id,
    selection: selectionOf(row), workflow_bound: row.metadata.workflow_bound, workflow_identity_id: row.metadata.workflow_identity_id,
    execution_context: row.metadata.execution_context, source: row.metadata.source });
}
const denied = () => new WorkflowError("WorkControlDenied", "The selected session cannot authorize workflow Stop.", 403);

/** Resolve current owned-session authority without turning a service credential into an operator. */
export async function sessionWorkflowScope(sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined, beforeBounds: () => Promise<void> = async () => {}, allowEndedRead = false) {
  if (principal?.kind !== "installation" || !expectedIdentity) throw denied();
  await authorizeSessionExecution(principal, { sessionId });
  const row = await getSession(sessionId);
  if (!row || (!allowEndedRead && (row.state !== "open" || row.ended_at !== null)) || row.identity_id === null) throw denied();
  const registry = installationRegistry(), identity = registry.identityId(row.identity_id);
  if (identity !== expectedIdentity) throw denied();
  await beforeBounds();
  const toolsList = await collectToolDefinitions();
  const selection = selectionOf(row), rawWorkflowBound = row.metadata.workflow_bound, approved = rawWorkflowBound === undefined ? undefined : approvedBoundsSchema.parse(rawWorkflowBound);
  const resolved = await resolveWorkflowSessionBounds(row.identity_id, {
    ...selection,
    ...(approved !== undefined ? { defaults: false, identityDefaults: false } : {}),
  }, toolsList);
  let execution: ToolCallBounds = { identity, bags: resolved.bags, bound: resolved.bound,
    allowedToolIds: resolved.tools.map(tool => qualifyToolId(tool.namespace, tool.name)), ...(selection.harness && (approved === undefined || approved.harness) ? { harness: selection.harness } : {}) };
  if (approved !== undefined) {
    if (row.metadata.workflow_identity_id !== row.identity_id) throw denied();
    execution = intersectWorkflowBounds(approved, execution, toolsList);
  }
  if (row.metadata.execution_context !== undefined) {
    const ceiling = retainedContext.parse(row.metadata.execution_context);
    if (ceiling.identity && ceiling.identity !== identity) throw denied();
    const ceilingBags = ceiling.bags ?? ceiling.traits ?? [];
    const evidence = { identity, bags: ceilingBags, traits: ceilingBags, bound: ceiling.bound, harness: ceiling.harness ?? execution.harness,
      tools: Object.fromEntries(toolsList.filter(tool => ceiling.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName))).map(tool => [qualifyToolId(tool.namespace, tool.toolName), tool.access])) };
    execution = intersectWorkflowBounds({ ...evidence, fingerprint: boundFingerprint(evidence) }, execution, toolsList);
  }
  // A delayed key/tool read must not revive a session closed or rebound in the meantime.
  const current = await getSession(sessionId);
  if (!current || sessionBinding(current) !== sessionBinding(row)) throw denied();
  await authorizeSessionExecution(principal, { sessionId });
  const tools = Object.fromEntries(toolsList.filter(tool => execution.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName))).map(tool => [qualifyToolId(tool.namespace, tool.toolName), tool.access]));
  const contracts = Object.fromEntries(toolsList.filter(tool => tool.contractHash && Object.hasOwn(tools, qualifyToolId(tool.namespace, tool.toolName))).map(tool => [qualifyToolId(tool.namespace, tool.toolName), tool.contractHash!]));
  const evidence = { identity, bags: execution.bags, traits: execution.bags ?? [], bound: execution.bound, ...(execution.harness === undefined ? {} : { harness: execution.harness }), tools, contracts };
  const validated = approvedBoundsSchema.parse({ ...evidence, fingerprint: boundFingerprint(evidence) });
  // Bound resolution may retain absent optional keys. Durable issuer evidence is JSON.
  const scope = approvedBoundsSchema.parse(JSON.parse(JSON.stringify(validated)));
  return { row, execution, scope, identity, node: registry.id, catalog: toolsList };
}

/** The installation caller selects a bounded session; this does not authenticate a session credential. */
export function sessionWorkflowActor(sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  return async (path: string, body?: unknown): Promise<string> => {
    if (!/^\/api\/v2\/work\/[^/]+\/stop$/.test(path) || body === undefined) throw denied();
    let key: string | undefined;
    const { execution, node } = await sessionWorkflowScope(sessionId, principal, expectedIdentity, async () => {
      key = (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY;
    });
    assertToolAllowed(execution, { namespace: "workflows", toolName: "cancel" }, node);
    return workflowActorSigner(execution, key)(path, body);
  };
}

/** An explicit (even invalid) session selection never falls back to operator authority. */
export function actionWorkflowAuthority(request: Request, context: StoreContext | undefined) {
  const selected = request.body?.sessionId !== undefined || request.body?.session_id !== undefined || request.body?.caller_session_id !== undefined || request.query.session_id !== undefined;
  const sessionId = requestSessionId(request);
  if (selected) return { operator: false, actor: sessionWorkflowActor(sessionId ?? "", request.authPrincipal, context?.identity) };
  return { operator: request.authPrincipal?.kind !== "device" && !context?.identity && !context?.execution && !context?.workflowActor,
    ...(request.authPrincipal?.kind !== "device" && context?.workflowActor ? { actor: context.workflowActor } : {}) };
}
