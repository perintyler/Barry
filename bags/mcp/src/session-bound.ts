import { Barry } from "@barry-rocks/sdk";
import { defaultTraits } from "@barry-rocks/sdk/internal/bags";
import { executionScopeSchema, intersectExecutionScope, qualifyToolId, type Bound, type ExecutionContext, type ToolMeta } from "@barry-rocks/sdk/bounds";
import { createLogger } from "@barry-rocks/sdk/logging";
import { selectionOf, sessionGrants } from "@barry-rocks/sessions-bag";
import { getSession } from "@barry-rocks/sessions-bag/client";
import type { SessionRecord } from "@barry-rocks/sessions-bag/client";

const log = createLogger("mcp-scope", { transport: "stderr" });

export interface ResolvedSessionBound {
  traits?: string[];
  harness?: string;
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
 * the default-trait grant, which is what a statically-configured client (the
 * Cursor IDE config writes `/mcp` with no session id) should get. Before
 * this, omitting `?sessionId=` was the one remaining way to receive the full
 * unscoped toolset with nothing but BARRY_SECRET.
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
    traits: [],
    bound: null,
    bounds: [],
    bound_id: null,
    metadata: {},
    created_at: "",
    started_at: null,
    completed_at: null,
    ended_at: null,
    // Maintained by a trigger on real rows (migration 032). This stand-in has
    // no messages, so null is the honest value rather than a placeholder.
    last_message_at: null,
  };
}

/**
 * What a session may call over MCP: the grants every launch path composes
 * (`sessionGrants`), held to the tools this server serves, and to a workflow's
 * approved ceiling when the session runs one.
 */
export async function resolveSessionBound(
  sessionId: string,
  toolMeta: ToolMeta[],
  prefetched?: { session?: SessionRecord; identity?: string; identityId?: number; harness?: string },
): Promise<ResolvedSessionBound> {
  // Anonymous is expected to have no row — skip the store round-trip and the
  // not-found warning that would otherwise fire on every anonymous initialize.
  const found = sessionId === ANONYMOUS_SESSION_ID
    ? undefined
    : prefetched?.session ?? await getSession(sessionId);
  if (!found && sessionId !== ANONYMOUS_SESSION_ID) {
    // Fail CLOSED to the default grant. Returning null here made the caller
    // skip filtering entirely, so a typo'd, reaped, or fabricated session id
    // was served the whole unscoped toolset (~360 tools) — strictly MORE
    // capability than any real session gets, cached for 10s and frozen into
    // the transport. An unknown session is now indistinguishable from a real
    // session that asked for nothing: DEFAULT_TRAITS only, no identity, no
    // extra scopes.
    log.warn("scope.session_not_found", { sessionId, served: "default-trait grant" });
  }
  const recorded = found ?? standIn(sessionId, prefetched?.identityId ?? null);
  const session = prefetched?.harness
    ? { ...recorded, metadata: { ...recorded.metadata, provider: prefetched.harness } }
    : recorded;
  const selection = selectionOf(session);
  const harness = selection.harness;
  const grants = await sessionGrants(session);

  // Fail closed on missing defaults: if NONE of the default traits resolved,
  // the DB hasn't been re-seeded. Historically this returned null (allow every
  // tool, no scope) — a silent security hole. Instead, log loudly and continue
  // with whatever traits DID resolve, so scope enforcement is never dropped.
  const expectedDefaults = defaultTraits();
  if (selection.defaults !== false && !expectedDefaults.some((name) => grants.traits.includes(name))) {
    log.error("scope.default_traits_missing", {
      sessionId,
      expected: expectedDefaults,
      hint: `run \`barry db seed\` to populate the default traits (${expectedDefaults.join("/")})`,
    });
  }

  // The grants decide over every registered tool; this server serves the
  // tools it was handed, so a granted tool it does not serve stays out.
  const granted = new Set(grants.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)));
  const allowed = toolMeta.filter((tool) => granted.has(qualifyToolId(tool.namespace, tool.toolName)));
  const bound = grants.bound;
  log.info("scope.resolved", {
    sessionId,
    identityId: session.identity_id,
    traits: grants.traits,
    namespaces: grants.namespaces,
    allowedCount: allowed.length,
    hasBound: Boolean(bound),
    denyPrograms: bound?.bash?.denyPrograms,
    networkActions: bound?.network?.actions,
    networkEnforce: bound?.network?.enforce,
    bounds: session.bounds,
  });

  if (session.metadata?.workflow_scope !== undefined) {
    const approved = executionScopeSchema.parse(session.metadata.workflow_scope);
    if (!prefetched?.identity || prefetched.identity !== approved.identity) throw new Error("workflow session identity binding is unavailable or changed");
    // The ceiling is held against what the session itself selects now, as it
    // was approved: no defaults and no identity traits, under the bound the
    // session runs with. A trait revoked since approval narrows the run.
    const selected = await Barry.grants({
      traits: session.traits,
      ...(approved.harness && harness ? { harness } : {}),
      inlineBound: bound,
      defaults: false,
      identityTraits: false,
    });
    const current: ExecutionContext = {
      identity: prefetched.identity,
      traits: selected.traits,
      bound: selected.bound,
      allowedToolIds: selected.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
      harness: approved.harness ? harness : undefined,
    };
    const effective = intersectExecutionScope(approved, current, toolMeta);
    return { allowedTools: new Set(effective.allowedToolIds.map(id => id.slice(id.indexOf(":") + 1))), allowedToolIds: new Set(effective.allowedToolIds), bound: effective.bound, traits: current.traits, harness };
  }
  return {
    allowedTools: new Set(allowed.map((tool) => tool.toolName)),
    allowedToolIds: new Set(allowed.map((tool) => qualifyToolId(tool.namespace, tool.toolName))),
    bound,
    traits: grants.traits,
    harness,
  };
}
