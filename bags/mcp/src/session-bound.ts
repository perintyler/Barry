import { Barry, type Tool } from "@barry-rocks/sdk";
import {
  approvedBoundsSchema,
  intersectWorkflowBounds,
  qualifyToolId,
  type Bound,
  type ToolDescriptor,
} from "@barry-rocks/sdk/bounds";
import { createLogger } from "@barry-rocks/sdk/logging";
import { getSession, type SessionRecord } from "@barry-rocks/sessions-bag/client";

const log = createLogger("mcp-scope", { transport: "stderr" });

export interface ResolvedSessionBound {
  identityId?: string;
  bags: string[];
  bounds: string[];
  harness?: string;
  tools: Tool[];
  /**
   * Bare allowed names. Safe for display and for logging a count; NOT safe as
   * a membership test that gates invocation, because two namespaces exporting
   * the same tool collapse to one entry. Use `allowedToolIds` for that.
   */
  allowedTools: Set<string>;
  /** Namespace-qualified tool ids govern invocation; bare names are display-only.
   * See docs/decisions/0037-service-route-and-tool-identity-rationale.md. */
  allowedToolIds: Set<string>;
  bound: Bound | null;
}

/**
 * The bound id anonymous MCP connections resolve under.
 *
 * It never has a session row, and that is the point: resolving it lands on
 * the base identity's non-optional bags and bounds, which is what a statically-
 * configured client (the Cursor IDE config writes `/mcp` with no session id)
 * should get.
 */
export const ANONYMOUS_SESSION_ID = "__anonymous__";

/** A session that selected nothing: what an anonymous or unknown session resolves as. */
function standIn(id: string, identityId: number | null): SessionRecord {
  return {
    id,
    active: false,
    state: "open",
    user_id: null,
    agent_token: "",
    identity_id: identityId,
    workflow_credential_id: null,
    status: "pending",
    system_prompt: null,
    summary: null,
    bags: [],
    bound: null,
    bounds: [],
    metadata: {},
    created_at: "",
    started_at: null,
    completed_at: null,
    ended_at: null,
    last_message_at: null,
  };
}

/**
 * What a session may call over MCP: the tools and bound resolved via
 * `Barry.bound` and `Barry.tools`, held to the tools this server serves and to
 * a workflow's approved ceiling when the session runs one.
 */
export async function sessionBound(
  sessionId: string,
  toolMeta: ToolDescriptor[],
  prefetched?: {
    session?: SessionRecord;
    identity?: string;
    identityId?: number;
    harness?: string;
  },
): Promise<ResolvedSessionBound> {
  // Anonymous is expected to have no row — skip the store round-trip and the
  // not-found warning that would otherwise fire on every anonymous initialize.
  const found =
    sessionId === ANONYMOUS_SESSION_ID
      ? undefined
      : prefetched?.session ?? (await getSession(sessionId));
  if (!found && sessionId !== ANONYMOUS_SESSION_ID) {
    // Fail CLOSED to the base identity's non-optional bags and bounds.
    log.warn("scope.session_not_found", {
      sessionId,
      served: "base-identity default",
    });
  }
  const recorded = found ?? standIn(sessionId, prefetched?.identityId ?? null);
  const harness =
    prefetched?.harness ??
    (typeof recorded.metadata?.harness === "string" && recorded.metadata.harness
      ? recorded.metadata.harness
      : typeof recorded.metadata?.provider === "string" && recorded.metadata.provider
        ? recorded.metadata.provider
        : undefined);
  const session = harness
    ? {
        ...recorded,
        metadata: { ...recorded.metadata, harness, provider: harness },
      }
    : recorded;

  const bags =
    session.bags && session.bags.length > 0
      ? [...session.bags]
      : [];
  const impliedReadBounds = bags.filter(
    (name) => name.endsWith(":read") || name.endsWith("-readonly"),
  );
  const bounds = [
    ...(session.bounds ? [...session.bounds] : []),
    ...impliedReadBounds,
  ];
  const identityRef = session.identity_id ?? null;
  const isExplicit = Boolean(
    session.metadata?.execution_context || session.metadata?.explicit_bags,
  );
  const toolIdentityRef = isExplicit ? null : identityRef;

  const bound =
    session.bound !== null && session.bound !== undefined
      ? Barry.Bound(session.bound as Bound)
      : await Barry.bound(identityRef, bounds);
  let resolvedTools = await Barry.tools(toolIdentityRef, bags, bound ?? undefined);

  const explicitBagNames = new Set(
    bags.map((name) =>
      name.endsWith(":read")
        ? name.slice(0, -":read".length)
        : name.endsWith("-readonly")
          ? name.slice(0, -"-readonly".length)
          : name,
    ),
  );
  if (explicitBagNames.size > 0 && toolMeta.length > 0) {
    const existingIds = new Set(
      resolvedTools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
    );
    const extraProxied = toolMeta
      .filter(
        (meta) =>
          explicitBagNames.has(meta.namespace) &&
          !existingIds.has(qualifyToolId(meta.namespace, meta.toolName)),
      )
      .map((meta) => ({
        name: meta.toolName,
        toolName: meta.toolName,
        namespace: meta.namespace,
        bag: meta.namespace,
        access: meta.access,
        network: meta.network,
      }));
    if (extraProxied.length > 0) {
      const filteredProxied = await Promise.resolve(
        Barry.tools(undefined, extraProxied, bound ?? undefined),
      );
      resolvedTools = [...resolvedTools, ...filteredProxied];
    }
  }

  const selectedNamespaces = Array.isArray(session.metadata?.selected_namespaces)
    ? (session.metadata.selected_namespaces as string[])
    : [];
  const selectedTools = Array.isArray(session.metadata?.selected_tools)
    ? (session.metadata.selected_tools as string[])
    : [];
  if (selectedNamespaces.length > 0 || selectedTools.length > 0) {
    const nsSet = new Set(selectedNamespaces);
    const toolSet = new Set(selectedTools);
    resolvedTools = resolvedTools.filter(
      (tool) =>
        tool.namespace === "barry" ||
        nsSet.has(tool.namespace) ||
        toolSet.has(tool.name) ||
        toolSet.has(qualifyToolId(tool.namespace, tool.name)),
    );
  }

  const granted = new Set(
    resolvedTools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
  );
  const allowed = toolMeta.filter((tool) =>
    granted.has(qualifyToolId(tool.namespace, tool.toolName)),
  );
  const servedIds = new Set(
    allowed.map((tool) => qualifyToolId(tool.namespace, tool.toolName)),
  );
  const servedTools = resolvedTools.filter((tool) =>
    servedIds.has(qualifyToolId(tool.namespace, tool.name)),
  );

  log.info("scope.resolved", {
    sessionId,
    identityId: session.identity_id,
    bags,
    bounds,
    allowedCount: allowed.length,
    hasBound: Boolean(bound),
    toolsBound: bound?.tools,
    bashBound: bound?.bash,
    networkBound: bound?.network,
  });

  const rawWorkflowCeiling =
    session.metadata?.workflow_bound;
  if (rawWorkflowCeiling !== undefined) {
    const approved = approvedBoundsSchema.parse(rawWorkflowCeiling);
    if (!prefetched?.identity || prefetched.identity !== approved.identity) {
      throw new Error(
        "workflow session identity binding is unavailable or changed",
      );
    }
    const effective = intersectWorkflowBounds(
      approved,
      {
        identity: prefetched.identity,
        bags,
        bounds,
        bound,
        allowedToolIds: allowed.map((tool) =>
          qualifyToolId(tool.namespace, tool.toolName),
        ),
        harness: approved.harness ? harness : undefined,
      },
      toolMeta,
    );
    const effectiveIds = new Set(effective.allowedToolIds);
    return {
      identityId: prefetched.identity,
      bags,
      bounds,
      harness,
      tools: servedTools.filter((tool) =>
        effectiveIds.has(qualifyToolId(tool.namespace, tool.name)),
      ),
      allowedTools: new Set(
        effective.allowedToolIds.map((id) => id.slice(id.indexOf(":") + 1)),
      ),
      allowedToolIds: effectiveIds,
      bound: effective.bound,
    };
  }

  return {
    ...(prefetched?.identity ? { identityId: prefetched.identity } : {}),
    bags,
    bounds,
    harness,
    tools: servedTools,
    allowedTools: new Set(allowed.map((tool) => tool.toolName)),
    allowedToolIds: servedIds,
    bound,
  };
}
