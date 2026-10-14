/**
 * Whom a run a session starts acts for, and what that session's own policy
 * lets the run do. Shared by the detached executor (routes/actions.ts) and job
 * runs (job-runs.ts), so a subagent and a session-started job are held to the
 * same rule: the run gets the caller's access and never more.
 */

import { boundHasContent, mergeBounds, qualifyToolId, type ExecutionContext } from "@barry-rocks/sdk/bounds";
import { Barry } from "@barry-rocks/sdk";
import { selectionOf } from "@barry-rocks/sessions-bag";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { isExecutorSessionMetadata } from "@barry-rocks/actions-bag";
import { resolveSessionNetworkScope } from "../session-agent-guards.js";

/** What a request may say about whom it acts for; each is checked against the caller. */
export interface CallerRequest {
  identity?: string;
  identity_id?: number;
  traits?: string[];
}

/** A refusal, as an HTTP answer. */
export interface CallerRefusal {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): CallerRefusal => ({ status, body });

/** The session a detached run acts for, and the traits the run may use. */
export interface CallerGrant {
  session: NonNullable<Awaited<ReturnType<typeof Sessions.get>>>;
  traits: string[];
  narrowed: boolean;
}


/**
 * Check a run's request against the session that started it.
 *
 * The run gets that session's access and never more: its barry, traits and
 * bounds come from the caller's row, and nothing in the request can widen
 * them. An unknown caller is refused rather than ignored, since falling back
 * to a bag's access would let a made-up id widen the run. `traits` narrows
 * only the traits recorded on the caller's row; the traits its barry grants
 * still apply, as they do to the caller. Every refusal leaves nothing behind.
 */
export async function resolveCallerGrant(
  callerSessionId: string,
  body: CallerRequest,
): Promise<CallerGrant | CallerRefusal> {
  const session = await Sessions.get(callerSessionId);
  if (!session) {
    return reply(404, { error: "unknown_caller_session", message: `No session "${callerSessionId}".` });
  }
  if (isExecutorSessionMetadata(session.metadata)) {
    return reply(409, {
      error: "nested_run",
      message: "The calling session is itself a detached run, and runs do not start further runs.",
    });
  }
  // run_action names the caller's own barry on every run, since it cannot
  // tell an ad-hoc action from an installed one before this resolves it.
  // Restating your own barry grants nothing; naming another would.
  if (body.identity || (body.identity_id !== undefined && body.identity_id !== session.identity_id)) {
    return reply(400, {
      error: "identity_not_allowed",
      message: "A run acts for the session that started it; it cannot be given another barry.",
    });
  }
  if (body.traits) {
    const notHeld = body.traits.filter((trait) => !session.traits.includes(trait));
    if (notHeld.length) {
      return reply(422, {
        error: "traits_not_held",
        message: `A subagent can only narrow its caller's access, and the caller does not hold ${notHeld.join(", ")}.`,
      });
    }
  }
  return { session, traits: body.traits ?? session.traits, narrowed: body.traits !== undefined };
}

/**
 * What a process a session starts may do: the calling session's own grants,
 * narrowed to the run's traits and without the installation's defaults. A raw
 * process can be run for a caller only when this holds `bash:Bash` and no
 * bound content, since a process cannot be held to a bound the way a guarded
 * tool is. Throws when the policy cannot be resolved.
 */
export async function callerScriptContext(caller: CallerGrant): Promise<ExecutionContext> {
  const { session } = caller;
  const selection = { ...selectionOf(session), traits: caller.traits, defaults: false };
  const granted = session.identity_id === null ? await Barry.grants(selection) : await Barry.identity(session.identity_id).grants(selection);
  const context: ExecutionContext = {
    traits: granted.traits,
    bound: granted.bound,
    allowedToolIds: granted.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
  };
  const provider = typeof session.metadata.provider === "string" ? session.metadata.provider : undefined;
  context.bound = mergeBounds(context.bound, await resolveSessionNetworkScope({ id: session.id, ...(provider ? { provider } : {}) }, caller.traits));
  return context;
}

/** Whether a caller's context may run a raw process: Bash granted, nothing bounded. */
export function permitsRawProcess(context: ExecutionContext): boolean {
  return !boundHasContent(context.bound ?? undefined) && context.allowedToolIds.includes("bash:Bash");
}
