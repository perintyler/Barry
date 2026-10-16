/**
 * Whom a run a session starts acts for, and what that session's own bounds
 * let the run do. Shared by the detached executor (routes/actions-executor.ts)
 * and job runs (job-runs.ts), so a subagent and a session-started job are held
 * to the same rule: the run gets the caller's access and never more.
 */

import {
  BoundSchema,
  boundHasContent,
  boundHasProcessRestrictions,
  isToolAllowedByBound,
  mergeBounds,
  qualifyToolId,
  readTwin,
  type Bound,
} from "@barry-rocks/sdk/bounds";
import { Barry, requestCaller, type Tool } from "@barry-rocks/sdk";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { isExecutorSessionMetadata } from "@barry-rocks/actions-bag";
import { sessionBound } from "../session-agent-guards.js";

/** What a request may say about whom it acts for; each is checked against the caller. */
export interface CallerRequest {
  identity?: string;
  identity_id?: number;
  bags?: string[];
  bounds?: (string | Bound | Record<string, unknown>)[];
}

/** A refusal, as an HTTP answer. */
export interface CallerRefusal {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): CallerRefusal => ({ status, body });

/** The session a detached run acts for, and the bags and bounds the run may use. */
export interface CallerBounds {
  session: NonNullable<Awaited<ReturnType<typeof Sessions.get>>>;
  bags: string[];
  bounds: string[];
  bound: Bound | null;
  narrowed: boolean;
}

function splitBagEntries(entries: readonly string[]): { bags: string[]; readTwins: string[] } {
  const bags: string[] = [];
  const readTwins: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith(":read") && entry.indexOf(":") > 0) {
      const bag = entry.slice(0, entry.indexOf(":"));
      if (!bags.includes(bag)) bags.push(bag);
      if (!readTwins.includes(entry)) readTwins.push(entry);
    } else if (!bags.includes(entry)) {
      bags.push(entry);
    }
  }
  return { bags, readTwins };
}

async function resolveAdditionalBound(
  identityId: number | null,
  requested: readonly (string | Bound | Record<string, unknown>)[],
  principal?: AuthPrincipal,
): Promise<Bound | null> {
  if (requested.length === 0) return null;
  const namedOrInline: (string | Bound)[] = [];
  let acc: Bound | null = null;
  for (const entry of requested) {
    if (typeof entry === "string") {
      if (entry.endsWith(":read") && entry.indexOf(":") > 0) {
        const bag = entry.slice(0, entry.indexOf(":"));
        acc = mergeBounds(acc, readTwin(bag));
      } else {
        namedOrInline.push(entry);
      }
    } else if (entry && typeof entry === "object") {
      acc = mergeBounds(acc, BoundSchema.parse(entry));
    }
  }
  if (namedOrInline.length > 0) {
    const resolved = await Barry.as(requestCaller(principal)).bound(identityId, namedOrInline);
    acc = mergeBounds(acc, resolved);
  }
  return acc;
}

/**
 * Check a run's request against the session that started it.
 *
 * The run gets that session's access and never more: its identity, bags and
 * bounds come from the caller's row, and nothing in the request can widen
 * them. An unknown caller is refused rather than ignored, since falling back
 * to a bag's access would let a made-up id widen the run. `bags` narrows only
 * the bags recorded on the caller's row, and `bounds` merges additional
 * restrictions onto the caller's pinned bound.
 */
export async function resolveCallerBounds(
  callerSessionId: string,
  body: CallerRequest,
  principal?: AuthPrincipal,
): Promise<CallerBounds | CallerRefusal> {
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
  if (body.identity || (body.identity_id !== undefined && body.identity_id !== session.identity_id)) {
    return reply(400, {
      error: "identity_not_allowed",
      message: "A run acts for the session that started it; it cannot be given another barry.",
    });
  }

  const sessionBags = session.bags ?? [];
  const requestedBagInput = body.bags;
  const split = requestedBagInput ? splitBagEntries(requestedBagInput) : null;
  if (split) {
    const notHeld = split.bags.filter(
      (bag) => !sessionBags.includes(bag),
    );
    if (notHeld.length > 0) {
      return reply(422, {
        error: "bags_not_held",
        bags: notHeld,
        message: `A subagent can only narrow its caller's access, and the caller does not hold ${notHeld.join(", ")}.`,
      });
    }
  }

  const requestedBounds: (string | Bound | Record<string, unknown>)[] = [
    ...(split?.readTwins ?? []),
    ...(body.bounds ?? []),
  ];

  let callerBound: Bound | null =
    session.bound && typeof session.bound === "object"
      ? BoundSchema.parse(session.bound)
      : null;
  if (!callerBound && session.bounds?.length) {
    try {
      callerBound = await Barry.as(requestCaller(principal)).bound(
        session.identity_id ?? null,
        session.bounds,
      );
    } catch {
      callerBound = null;
    }
  }

  let mergedBound = callerBound;
  if (requestedBounds.length > 0) {
    try {
      const extraBound = await resolveAdditionalBound(
        session.identity_id ?? null,
        requestedBounds,
        principal,
      );
      mergedBound = mergeBounds(mergedBound, extraBound);
    } catch (error) {
      return reply(422, {
        error: "invalid_bounds",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stringBounds = [
    ...(session.bounds ?? []),
    ...requestedBounds.filter((b): b is string => typeof b === "string"),
  ];
  const uniqueStringBounds = [...new Set(stringBounds)];
  const activeBags = split ? split.bags : sessionBags;
  const narrowed = requestedBagInput !== undefined || (body.bounds !== undefined && body.bounds.length > 0);

  return {
    session,
    bags: activeBags,
    bounds: uniqueStringBounds,
    bound: boundHasContent(mergedBound) ? mergedBound : null,
    narrowed,
  };
}

export interface CallerScriptBound {
  identity?: string;
  bags: string[];
  bound: Bound | null;
  tools: Tool[];
  allowedToolIds: string[];
  harness?: string;
}

/**
 * What a process a session starts may do: the calling session's own tools and
 * bound, narrowed to the run's bags and bounds. A raw process can be run for a
 * caller only when this holds `bash:Bash` and no process-level bound
 * restrictions (`files`, `bash`, `network`, `inputs`).
 */
export async function callerScriptBound(
  caller: CallerBounds,
  principal?: AuthPrincipal,
): Promise<CallerScriptBound> {
  const { session } = caller;
  const provider =
    typeof session.metadata?.provider === "string" ? session.metadata.provider : undefined;
  const resolvedBound = await sessionBound(
    { id: session.id, ...(provider ? { provider } : {}) },
    caller.bound ? [caller.bound] : caller.bounds,
  );
  const mergedBound = mergeBounds(caller.bound, resolvedBound);
  const isExplicit = Boolean(
    caller.narrowed ||
      session.metadata?.execution_context ||
      session.metadata?.explicit_bags,
  );
  const tools = await Barry.as(requestCaller(principal)).tools(
    isExplicit ? null : (session.identity_id ?? null),
    caller.bags,
    mergedBound ?? undefined,
  );
  const allowedToolIds = tools.map((tool) => qualifyToolId(tool.namespace, tool.name));
  return {
    bags: caller.bags,
    bound: mergedBound,
    tools,
    allowedToolIds,
  };
}

/** Whether a caller's resolved bound and tools may run a raw process: Bash enabled, no process restrictions. */
export function permitsRawProcess(
  context: { bound?: Bound | null; allowedToolIds?: readonly string[]; tools?: readonly Tool[] },
): boolean {
  if (boundHasProcessRestrictions(context.bound ?? undefined)) {
    return false;
  }
  if (
    !isToolAllowedByBound(
      { namespace: "bash", toolName: "Bash", access: "write" },
      context.bound ?? undefined,
    )
  ) {
    return false;
  }
  if (Array.isArray(context.allowedToolIds)) {
    return context.allowedToolIds.includes("bash:Bash");
  }
  return Boolean(
    context.tools?.some(
      (tool) =>
        tool.name === "bash:Bash" || (tool.namespace === "bash" && tool.name === "Bash"),
    ),
  );
}
