import { Barry, requestCaller } from "@barry-rocks/sdk";
import { assertToolAllowed } from "@barry-rocks/sdk/bounds";
import { workflowActorSigner, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { actionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serviceAddress } from "@barry-rocks/sdk/services";
import { expandCompositionFromSnapshot } from "@barry-rocks/sdk/internal/bags";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { listSessions } from "@barry-rocks/sessions-bag/client";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { WorkflowError, type WorkReadService, type WorkResult } from "@barry-rocks/sdk/internal/workflows";
import { sessionWorkflowScope } from "./session-workflow-control.js";

const itemSchema = actionsRoutes.getSessionWorkflowWork.responses[200];
const resultSchema = actionsRoutes.getSessionWorkflowWorkResult.responses[200];
const stopSchema = actionsRoutes.stopSessionWorkflowWork.body;
const ackSchema = actionsRoutes.stopSessionWorkflowWork.responses[202];
const idSchema = actionsRoutes.getSessionWorkflowWork.params.shape.id;
type CanonicalItem = Omit<Awaited<ReturnType<WorkReadService<unknown>["inspect"]>>, "projection">;
const denied = () => new WorkflowError("WorkReadDenied", "The selected session cannot access this workflow operation.", 403);
const refusedStops = new WeakSet<object>();
export const sessionWorkflowStopRefused = (error: unknown) => error !== null && typeof error === "object" && refusedStops.has(error);

/** A minimal owned-session picker, never an installation-wide session inventory. */
export async function listSessionWorkflowSelections(principal: AuthPrincipal | undefined) {
  if (principal?.kind !== "installation") throw denied();
  try {
    await authorizeSessionExecution(principal, {});
    const caller = Barry.as(requestCaller(principal)), owned = await caller.identities(), identityIds = owned.map(identity => identity.id);
    if (!identityIds.length) return { sessions: [] };
    const rows = await withStoreContext({}, () => listSessions({ access: { actorId: principal.actorId, identityIds }, limit: 100, orderBy: "activity" }));
    await authorizeSessionExecution(principal, {});
    const currentIds = new Set((await caller.identities()).map(identity => identity.id));
    return { sessions: rows.filter(row => row.identity_id !== null && currentIds.has(row.identity_id) && (row.user_id === null || row.user_id === principal.actorId))
      .map(row => ({ id: row.id, name: typeof row.metadata.name === "string" && row.metadata.name.trim() ? row.metadata.name : null,
        identity_id: row.identity_id!, ended: row.state !== "open" || row.ended_at !== null })) };
  } catch { throw denied(); }
}

/** Owned/current selection is checked before catalog discovery and after its asynchronous reads. */
export async function sessionWorkflowCatalog(sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  try {
    const resolve = async () => {
      const selected = await sessionWorkflowScope(sessionId, principal, expectedIdentity, undefined, true);
      assertToolAllowed(selected.execution, { namespace: "workflows", toolName: "get" }, selected.node);
      return selected;
    };
    const selected = await resolve(), caller = Barry.as(requestCaller(principal));
    const identity = await caller.identity(selected.row.identity_id!).get();
    const bags = await expandCompositionFromSnapshot(identity.bags), actions = await caller.identity(selected.row.identity_id!).session(sessionId).actions();
    const current = await resolve();
    if (current.identity !== selected.identity || current.scope.fingerprint !== selected.scope.fingerprint) throw denied();
    return { count: actions.length, actions: actions.map(action => ({ name: action.name, qualified_name: action.qualifiedName, bag: action.bag,
      description: action.description, executable: action.executable, input_names: [...action.inputs], ...(action.inputSchema ? { input_schema: action.inputSchema } : {}) })),
    scope: { kind: "identity" as const, identity: identity.name, bags } };
  } catch { throw denied(); }
}

/** Only explicitly selected, currently authorized identity scope signs owner hops. */
function selectedConnection(sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined, stop: boolean, forwarding?: () => void) {
  const resolve = async () => {
    const authorize = async () => {
      try {
        const selected = await sessionWorkflowScope(sessionId, principal, expectedIdentity, undefined, !stop);
        assertToolAllowed(selected.execution, { namespace: "workflows", toolName: stop ? "cancel" : "get" }, selected.node);
        return selected;
      } catch { throw denied(); }
    };
    // Caller denial and missing installation configuration have different
    // remedies. Establish authority before reading configuration, then check
    // it again even if that asynchronous read failed.
    const selected = await authorize();
    let actorKey: string | undefined;
    try { actorKey = (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY; }
    catch { /* A declared but unreadable binding remains unavailable. */ }
    const current = await authorize();
    if (current.identity !== selected.identity || current.node !== selected.node || current.scope.fingerprint !== selected.scope.fingerprint) throw denied();
    if (!actorKey || actorKey.length < 32) throw new WorkflowError("WorkActorUnavailable", "Selected identity workflow access requires a readable declared actor signing key.", 503, true);
    return { ...current, actorKey };
  };
  return async () => {
    const selected = await resolve(), address = serviceAddress("workflows.runtime"), base = new URL(address.endsWith("/") ? address : `${address}/`);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new WorkflowError("WorkOwnerUnavailable", "Configured workflow address is invalid.", 503, true);
    const secret = process.env.BARRY_SECRET ?? (await installationSecrets(["BARRY_SECRET"])).BARRY_SECRET;
    if (!secret) throw new WorkflowError("WorkOwnerUnavailable", "Workflow service credentials are unavailable.", 503, true);
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const metadata = await fetch(new URL("api/metadata", base), { headers, signal: AbortSignal.timeout(5000) });
    if (!metadata.ok || (await metadata.json()).installation !== selected.node) throw new WorkflowError("WorkOwnerMismatch", "The configured workflow service belongs to another installation.", 409);
    // Metadata and secret reads are asynchronous. Do not reuse authority from
    // before those reads, even for an already-open HTTP connection.
    const current = await resolve();
    if (current.identity !== selected.identity || current.node !== selected.node) throw denied();
    const send = async (path: string, body?: unknown) => {
      const fresh = await resolve();
      if (fresh.identity !== current.identity || fresh.node !== current.node) throw denied();
      const actor = workflowActorSigner(fresh.execution, fresh.actorKey)(path, body);
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (body !== undefined) forwarding?.();
      const response = await fetch(new URL(path.slice(1), base), { method: body === undefined ? "GET" : "POST",
        headers: { ...headers, "X-Workflow-Actor": actor }, ...(encoded === undefined ? {} : { body: encoded }), signal: AbortSignal.timeout(10000) });
      const value = await response.json();
      if (!response.ok) {
        const failure = new WorkflowError(typeof value.code === "string" ? value.code : "WorkUnavailable", typeof value.error === "string" ? value.error : "Workflow operation was refused.", response.status, Boolean(value.retryable));
        // These canonical errors occur before stopWork mutates any state.
        // Never infer non-acceptance from an arbitrary HTTP status alone.
        if (stop && ((response.status === 409 && ["WorkRevisionConflict", "WorkStopUnavailable"].includes(value.code))
          || response.status === 404 && value.code === "WorkNotFound" || response.status === 403 && value.code === "Forbidden")) refusedStops.add(failure);
        throw failure;
      }
      const confirmed = body === undefined ? await resolve() : fresh;
      if (confirmed.identity !== fresh.identity || confirmed.node !== fresh.node || body === undefined && confirmed.scope.fingerprint !== fresh.scope.fingerprint) throw denied();
      return { value, response, selected: confirmed };
    };
    return { send };
  };
}

function checkedItem(value: unknown, workId: string, selected: { identity: string; node: string }): CanonicalItem {
  // The canonical owner includes private projection bookkeeping. The public
  // shape intentionally strips it rather than forwarding arbitrary fields.
  const item = itemSchema.strip().parse(value);
  if (item.work_id !== workId || item.namespace.installation !== selected.node || item.namespace.principal_kind !== "identity"
    || item.namespace.principal_id !== selected.identity || item.namespace.identity_id !== selected.identity) throw new Error("Work response differs from selected identity.");
  return item;
}

/** Canonical inspection does not depend on the Actions projection existing. */
export async function readSessionWorkflowWork(workId: string, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  workId = idSchema.parse(workId);
  try {
    const connection = await selectedConnection(sessionId, principal, expectedIdentity, false)();
    const read = await connection.send(`/api/v2/work/${encodeURIComponent(workId)}`), item = checkedItem(read.value, workId, read.selected);
    let mayStop = read.selected.row.state === "open" && read.selected.row.ended_at === null;
    try { assertToolAllowed(read.selected.execution, { namespace: "workflows", toolName: "cancel" }, read.selected.node); } catch { mayStop = false; }
    return { ...item, allowed_actions: item.allowed_actions.filter(action => action !== "stop" || mayStop) };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("WorkReadUnknown", "Workflow inspection is unavailable; preserve the work ID and selected session.", 503, true);
  }
}

/** Payload authority remains the owner's decision; the bridge never downgrades a denial into metadata. */
export async function readSessionWorkflowWorkResult(workId: string, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined): Promise<WorkResult> {
  workId = idSchema.parse(workId);
  try {
    const connection = await selectedConnection(sessionId, principal, expectedIdentity, false)();
    const inspected = await connection.send(`/api/v2/work/${encodeURIComponent(workId)}`);
    checkedItem(inspected.value, workId, inspected.selected);
    const read = await connection.send(`/api/v2/work/${encodeURIComponent(workId)}/result`), result = resultSchema.parse(read.value);
    if (result.work_id !== workId) throw new Error("Result differs from requested work.");
    return result;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("WorkReadUnknown", "Workflow result is unavailable; preserve the work ID and selected session.", 503, true);
  }
}

/** Cancel-only authority is sufficient; the owner checks canonical identity ownership. */
export async function stopSessionWorkflowWork(workId: string, input: unknown, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  let forwarded = false;
  try {
    workId = idSchema.parse(workId);
    const intent = stopSchema.parse(input);
    const connection = await selectedConnection(sessionId, principal, expectedIdentity, true, () => { forwarded = true; })();
    const sent = await connection.send(`/api/v2/work/${encodeURIComponent(workId)}/stop`, intent), ack = ackSchema.parse(sent.value);
    if (sent.response.status !== 202 && sent.response.status !== 200) throw new Error("Unexpected Stop acknowledgement status.");
    if (ack.work_id !== workId || ack.request_id !== intent.request_id || ack.applied_revision < intent.expected_revision) throw new Error("Stop acknowledgement differs from original intent.");
    return ack;
  } catch (error) {
    if (!forwarded && error !== null && typeof error === "object") refusedStops.add(error);
    if (error instanceof WorkflowError) throw error;
    const failure = new WorkflowError("WorkStopUnknown", "Workflow Stop is unconfirmed; preserve its work ID, selected session, request ID, revision and reason.", 503, true);
    if (!forwarded) refusedStops.add(failure);
    throw failure;
  }
}
