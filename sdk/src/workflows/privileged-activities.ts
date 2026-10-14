import type { WorkflowOwner } from "./workflow-owner.js";
import { ActivityFailure, type Activity, type Json } from "./types.js";
import type { ScopedToolInvoker } from "../tools/scoped-invocation.js";
import { workflowSessionId, type WorkflowSessionTurns } from "../sessions/workflow-turns.js";

/** Trusted typed adapters are supplied explicitly; application bundles get no Barry credentials. */
export function toolActivity(options: { owner: WorkflowOwner; worker: string; node: string; tool: string; invoker: ScopedToolInvoker }): Activity {
  return async (input, task) => {
    if (task.signal.aborted || !task.grantRevision) throw new ActivityFailure("Run authority is unavailable", "GrantRequired");
    const check = () => { options.owner.effectAuthority(options.worker, task.token, task.grantRevision!); };
    const { grant } = options.owner.effectAuthority(options.worker, task.token, task.grantRevision);
    if (!input || Array.isArray(input) || typeof input !== "object") throw new ActivityFailure("Tool input must be an object", "InvalidInput");
    try { return await options.invoker.invoke({ key: `${task.owner}/${task.idempotencyKey}`, node: options.node, tool: options.tool, input, approvedFingerprint: grant.scope.fingerprint }, check) as Json; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("OutcomeUnknown")) options.owner.blockExecution(task.runId, message);
      else if (message.startsWith("ToolContractUnavailable") || message.startsWith("tool access denied") || message.startsWith("node access denied") || message.startsWith("required resource restrictions cannot be enforced")) options.owner.blockExecution(task.runId, "PolicyRevoked: " + message);
      throw error;
    }
  };
}
export function sessionTurnActivity(options: { owner: WorkflowOwner; worker: string; sessions: WorkflowSessionTurns }): Activity {
  return async (input, task) => {
    if (!task.grantRevision) throw new ActivityFailure("Session turn requires an approved run", "GrantRequired");
    const key = `${task.owner}/${task.idempotencyKey}`;
    const check = () => options.owner.effectAuthority(options.worker, task.token, task.grantRevision!);
    const { grant } = check();
    if (!grant.scope.identity) throw new ActivityFailure("Session turn requires an identity", "GrantRequired");
    const bindingKey = `${task.owner}/${task.runId}`;
    const sessionId = workflowSessionId(bindingKey, grant.scope.identity);
    // Commit the external dependency before Sessions can create its resource.
    // An unknown creation outcome must remain visible to backup/reconciliation.
    options.owner.bindSession(task.runId, task.activityId, sessionId, key);
    const abort = () => { void options.sessions.interrupt(key).catch(() => {}); };
    task.signal.addEventListener("abort", abort, { once: true });
    try {
      if (task.signal.aborted) throw new ActivityFailure("Turn cancelled", "Cancelled");
      await options.sessions.ensure(bindingKey, grant.scope);
      check();
      if (task.signal.aborted) throw new ActivityFailure("Turn cancelled", "Cancelled");
      const result = await options.sessions.turn(key, sessionId, input, grant.scope);
      options.owner.bindSession(task.runId, task.activityId, sessionId, key, "complete");
      return result as Json;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("OutcomeUnknown")) options.owner.blockExecution(task.runId, message);
      else if (message.startsWith("session identity or execution ceiling mismatch") || message.startsWith("session scope is invalid or cannot be enforced")) options.owner.blockExecution(task.runId, "PolicyRevoked: " + message);
      throw error;
    } finally { task.signal.removeEventListener("abort", abort); }
  };
}
