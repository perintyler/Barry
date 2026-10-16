import { join } from "node:path";
import { z } from "zod";
import { assertBoundDelegation, assertToolAllowed, boundHasContent, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { actionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { workflowActorSigner, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { bagDataDir, serviceAddress } from "@barry-rocks/sdk/services";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { WorkDelegationIssuer, WorkflowError, readWorkDelegationKeys, workDelegationSigningKey, workAdmissionSchema, workIntentHash, workNamespaceSchema, type WorkAuthority } from "@barry-rocks/sdk/internal/workflows";
import { sessionWorkflowScope } from "./session-workflow-control.js";

export const sessionWorkStartRequest = actionsRoutes.startSessionWorkflowAction.body;
const issuerName = "workflows.sessions.identity";
const reference = z.string().min(1).max(200);
const actionName = reference.regex(/^[^:@]+:[^:@]+$/);
const unavailable = () => new WorkflowError("WorkAdmissionUnavailable", "Identity work admission needs an active dedicated workflows.sessions.identity delegation key.", 503);
const refusedAttempts = new WeakSet<object>();
/** This attempt did not forward, or the trusted owner explicitly proved non-acceptance.
 * A later refusal never proves an earlier ambiguous attempt did not commit. */
export const sessionWorkAdmissionRefused = (error: unknown) => error !== null && typeof error === "object" && refusedAttempts.has(error);

async function workflowConnection(installation: string) {
  const address = serviceAddress("workflows.runtime"), base = new URL(address.endsWith("/") ? address : `${address}/`);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new WorkflowError("WorkOwnerUnavailable", "Configured workflow address is invalid.", 503, true);
  const secret = process.env.BARRY_SECRET ?? (await installationSecrets(["BARRY_SECRET"])).BARRY_SECRET;
  if (!secret) throw new WorkflowError("WorkOwnerUnavailable", "Workflow service credentials are unavailable.", 503, true);
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const metadata = await fetch(new URL("api/metadata", base), { headers, signal: AbortSignal.timeout(5000) });
  if (!metadata.ok || (await metadata.json()).installation !== installation) throw new WorkflowError("WorkOwnerMismatch", "The configured workflow service belongs to another installation.", 409);
  return { base, headers };
}

/** Explicit opt-in admission. Existing Actions launch routes retain their owners. */
export async function startSessionWorkflowAction(name: string, input: unknown, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  return sessionWorkflowAdmission(name, input, sessionId, principal, expectedIdentity, "process");
}

/** Explicit agent producer; its original ceiling is signed unchanged. */
export async function startSessionWorkflowAgentAction(name: string, input: unknown, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  return sessionWorkflowAdmission(name, input, sessionId, principal, expectedIdentity, "agent");
}
async function sessionWorkflowAdmission(name: string, input: unknown, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined, executor: "process" | "agent") {
  let forwarded = false;
  try { return await preparedSessionWorkflowAction(name, input, sessionId, principal, expectedIdentity, () => { forwarded = true; }, executor); }
  catch (error) {
    if ((!forwarded || error instanceof WorkflowError && error.admissionDisposition === "not-accepted") && error !== null && typeof error === "object") refusedAttempts.add(error);
    throw error;
  }
}

async function preparedSessionWorkflowAction(name: string, input: unknown, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined, forwarding: () => void, executor: "process" | "agent") {
  const parsed = sessionWorkStartRequest.parse(input), qualified = actionName.parse(name);
  const resolve = async () => {
    try {
      const selected = await sessionWorkflowScope(sessionId, principal, expectedIdentity);
      if (selected.row.metadata.workflow_bound !== undefined || ["action-executor", "workflow-destination"].includes(String(selected.row.metadata.source)) || selected.row.metadata.execution_context !== undefined) throw new WorkflowError("NestedWorkDenied", "A detached execution cannot submit another detached action.", 403);
      assertToolAllowed(selected.execution, { namespace: "workflows", toolName: "start" }, selected.node);
      if (executor === "process") assertToolAllowed(selected.execution, { namespace: "bash", toolName: "Bash" }, selected.node);
      if (executor === "process" && (boundHasContent(selected.scope.bound ?? undefined) || !selected.scope.contracts?.["bash:Bash"])) throw new WorkflowError("UnsupportedProcessProgram", "Installed scripts require the retained unbounded Bash write contract.", 409);
      return selected;
    } catch (error) {
      if (error instanceof WorkflowError && error.code !== "WorkControlDenied") throw error;
      throw new WorkflowError("WorkAdmissionDenied", "The selected session's current authority does not permit installed script admission.", 403);
    }
  };
  const selected = await resolve();
  const keyPath = process.env.BARRY_WORKFLOW_DELEGATION_KEYS;
  const signingKey = () => {
    const key = keyPath ? workDelegationSigningKey(readWorkDelegationKeys(keyPath)[issuerName] ?? []) : undefined;
    if (!key) throw unavailable();
    return key;
  };
  signingKey();
  const origin = { entry_point: executor === "agent" ? "sessions-agent-work-api" : "sessions-work-api", trigger: "invocation" as const, caller_session_id: sessionId };
  const authority: WorkAuthority = { namespace: { installation: selected.node, principal_kind: "identity", principal_id: selected.identity, identity_id: selected.identity, caller_session_id: sessionId },
    origin, run_identity: selected.identity, caller_ceiling: selected.scope };
  const definition = { kind: "action" as const, reference: qualified, catalog_namespace: qualified.slice(0, qualified.indexOf(":")) };
  const issuer = new WorkDelegationIssuer({ path: join(bagDataDir("sessions"), "work-admission-issuer.db"), issuer: issuerName, signingKey });
  try {
    // Commit the original key/intent/ceiling before any possible forwarding.
    const prepared = issuer.prepare({ version: 2, ...parsed, origin, definition }, authority, { kind: "session", definition_owner_session: null, background_parent: false });
    const connection = await workflowConnection(selected.node);
    const current = await resolve();
    assertBoundDelegation(prepared.record.authority.caller_ceiling, current.execution, current.catalog);
    const submission = JSON.stringify({ request: prepared.request, delegation: issuer.issue(prepared.request, authority) });
    forwarding();
    const response = await fetch(new URL("api/v2/work/submissions", connection.base), { method: "POST", headers: connection.headers,
      body: submission, signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw new WorkflowError(typeof value.code === "string" ? value.code : "WorkAdmissionRejected", typeof value.error === "string" ? value.error : "Work admission was refused.", response.status, Boolean(value.retryable), value.admission_disposition === "not-accepted" ? "not-accepted" : undefined);
    const work = workAdmissionSchema.parse(value.work);
    if (![200, 201].includes(response.status) || !work.action_id || boundFingerprint(work.namespace) !== boundFingerprint(authority.namespace)
      || work.idempotency_key !== parsed.idempotency_key || work.request_hash !== workIntentHash(prepared.request, authority.namespace)
      || boundFingerprint(work.origin) !== boundFingerprint(origin) || boundFingerprint(work.plan.definition) !== boundFingerprint(definition)) throw new Error("Admission acknowledgement differs from its original intent.");
    return { run_id: work.action_id, work_id: work.work_id, workflow_id: work.workflow_id, idempotency_key: parsed.idempotency_key, created: response.status === 201 };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    const failure = new WorkflowError("WorkAdmissionUnknown", `Admission is unconfirmed. Preserve key ${parsed.idempotency_key}, the original session and inputs; use operation lookup or retry the same intent.`, 503, true);
    failure.cause = error;
    throw failure;
  } finally { issuer.close(); }
}

/** Read recovery neither mints delegation nor requires permission to start again. */
export async function lookupSessionWorkflowAction(key: string, sessionId: string, principal: AuthPrincipal | undefined, expectedIdentity: string | undefined) {
  key = reference.parse(key);
  let actorKey: string | undefined;
  const resolve = async () => {
    try {
      const selected = await sessionWorkflowScope(sessionId, principal, expectedIdentity, async () => {
        actorKey = (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY;
      }, true);
      assertToolAllowed(selected.execution, { namespace: "workflows", toolName: "get" }, selected.node);
      return selected;
    } catch { throw new WorkflowError("WorkLookupDenied", "The selected session's current authority does not permit operation lookup.", 403); }
  };
  const selected = await resolve();
  const connection = await workflowConnection(selected.node), current = await resolve();
  const path = `/api/v2/work/operations?${new URLSearchParams({ key, session: sessionId })}`;
  try {
    const token = workflowActorSigner(current.execution, actorKey)(path);
    const response = await fetch(new URL(path.slice(1), connection.base), { headers: { ...connection.headers, "X-Workflow-Actor": token }, signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw new WorkflowError(typeof value.code === "string" ? value.code : "WorkLookupUnavailable", typeof value.error === "string" ? value.error : "Work lookup is unavailable.", response.status, Boolean(value.retryable));
    const result = z.object({ version: z.literal(2), work_id: reference, workflow_id: reference, action_id: reference, namespace: workNamespaceSchema }).parse(value);
    if (result.namespace.installation !== selected.node || result.namespace.principal_kind !== "identity" || result.namespace.principal_id !== selected.identity || result.namespace.identity_id !== selected.identity || result.namespace.caller_session_id !== sessionId) throw new Error("Lookup acknowledgement differs from the selected namespace.");
    return { run_id: result.action_id, work_id: result.work_id, workflow_id: result.workflow_id, idempotency_key: key, created: false as const };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("WorkLookupUnknown", "Operation lookup is unconfirmed; preserve the original key and inputs.", 503, true);
  }
}
