/**
 * The restrictions every Barry-driven agent runs under, beyond the MCP tools
 * its session is granted: which of its agent's own native tools it loses, and
 * the network sandbox its bound calls for.
 *
 * Shared by a session's agent (session-runtime) and a subagent run for one
 * (the action executor), so a subagent can never be looser than the session
 * that started it because the two computed the same rule differently.
 */

import type { Bound } from "@barry-rocks/sdk/bounds";
import { executionScopeSchema, scopeFingerprint, mergeBounds, resolveNativePolicy } from "@barry-rocks/sdk/bounds";
import { Barry, type GrantSelection, type Grants } from "@barry-rocks/sdk";
import { selectionOf } from "@barry-rocks/sessions-bag";
import type { SessionRecord } from "@barry-rocks/sessions-bag/client";

import { canEnforceInSandbox, type EgressPolicy } from "@barry-rocks/sdk/sessions";
import { installedModels, routedVendorOf } from "@barry-rocks/sdk/adapters/models";
import { getDescribeAdapter } from "./agent-runtime.js";
import { createLogger } from "@barry-rocks/sdk/logging";
import { getSessionRecord } from "./db.js";

// The session runtime's logger, so the sandbox events keep the name every
// existing log query and alert already looks for.
const log = createLogger("session-runtime");

/** The hosted native policy uses the same grants as every other session capability. */
export async function nativeToolPolicy(session: SessionGrant, narrowedTo?: readonly string[]) {
  const grants = await sessionAgentGrants(session, narrowedTo);
  const record = getDescribeAdapter()?.(session.provider ?? "");
  if (!record) {
    if (Object.values(grants.bound?.nativeTools ?? {}).some(tools => tools.length)) throw new Error(`no installed adapter policy for ${session.provider}`);
    return { allowed: [], denied: [], refused: {}, uncontrolled: {}, conflicts: {} };
  }
  return resolveNativePolicy(grants, record, "hosted");
}

/**
 * Whether this agent can enforce a denied-tools list at all.
 *
 * Only providers declaring `toolDenial: "native"` can. On the others the CLI
 * has no denial mechanism, so natively-run shell escapes every bash
 * restriction, and the runners throw on a non-empty list.
 */
export function canDenyNativeTools(provider: string): boolean {
  // An adapter this API has no record of enforces nothing it has declared.
  return getDescribeAdapter()?.(provider)?.capabilities.toolDenial === "native";
}

/**
 * Whether the egress proxy can actually be enforced for this agent and model.
 *
 * The ENDPOINT has the final say, the same way it does for `structuredOutput`
 * in `runStructured`. Whether the proxy can be enforced is a fact about where
 * requests actually go, not about which agent binary sends them: the claude
 * SDK path talking to a localhost Ollama daemon is not the claude SDK path
 * talking to api.anthropic.com, and each vendor's endpoint says so.
 *
 * Reading only the harness's own answer declared a network scope ENFORCED on
 * an Ollama-routed session — claude's hosted mode says `true`, Ollama's
 * endpoint says `false` — which is exactly the silent downgrade the caller's
 * warning exists to prevent.
 */
export function supportsEgressSandbox(provider: string, model?: string, modelProvider?: string): boolean {
  const record = getDescribeAdapter()?.(provider);
  if (!record) return false;
  const vendors = installedModels().vendors();
  const vendor = modelProvider ?? (model ? routedVendorOf(record, model, vendors)?.id : undefined);
  const routed = vendor && record.vendor && vendor !== record.vendor ? installedModels().endpoint(vendor, record.vendor) : undefined;
  return routed?.egressSandbox ?? record.modes.hosted?.egressSandbox ?? false;
}

/** The session an agent acts for, and the harness it runs on. */
export interface SessionGrant {
  id: string;
  provider?: string;
  workflowScoped?: boolean;
}

// The service composes its sessions' grants with the installation's authority:
// whoever asked to start one was authorized for it before this runs.

/**
 * What an agent acting for this session is granted: the session's own grants,
 * unless something narrows them. A run the session starts may keep fewer of
 * its traits and run on another harness; a workflow session is granted only
 * what its job names, none of the defaults or its identity's own traits.
 */
async function agentGrants(row: SessionRecord | undefined, narrowedTo: readonly string[] | undefined, harness: string | undefined): Promise<Grants> {
  if (!row) return Barry.grants({ ...(harness ? { harness } : {}), mode: "hosted", ...(narrowedTo ? { traits: narrowedTo } : {}) });
  const own = selectionOf(row);
  const otherHarness = harness !== undefined && harness !== own.harness;
  const workflow = row.metadata?.workflow_scope !== undefined;
  const selection: GrantSelection = {
    ...own,
    mode: "hosted",
    ...(narrowedTo ? { traits: narrowedTo } : {}),
    ...(otherHarness ? { harness } : {}),
    ...(workflow ? { defaults: false, identityTraits: false } : {}),
  };
  return row.identity_id === null ? Barry.grants(selection) : Barry.identity(row.identity_id).grants(selection);
}

/**
 * The bound an agent for this session runs under, from the session's grants;
 * `narrowedTo` is the subset of its traits a run it starts keeps. A workflow
 * session's is also held to the ceiling its job was approved with.
 */
export async function sessionAgentGrants(session: SessionGrant, narrowedTo?: readonly string[]): Promise<Grants> {
  const dbSession = await getSessionRecord(session.id);
  const record = getDescribeAdapter()?.(session.provider ?? "");
  const workflowScope = dbSession?.metadata?.workflow_scope;
  const grants = await agentGrants(dbSession, narrowedTo, record?.id);
  const current = grants.bound;
  if (workflowScope === undefined) return grants;
  const approved = executionScopeSchema.parse(workflowScope);
  const { fingerprint, ...evidence } = approved;
  const identityId = dbSession?.identity_id;
  if (!approved.identity || !identityId || dbSession?.metadata?.workflow_identity_id !== identityId || fingerprint !== scopeFingerprint(evidence) || (approved.harness && approved.harness !== record?.id)) throw new Error("workflow session identity, harness or execution ceiling is invalid");
  if (!record) throw new Error("workflow harness native-tool inventory is unavailable");
  // Job traits grant Barry tools, not a harness's ambient native inventory.
  return { ...grants, bound: mergeBounds(mergeBounds(approved.bound, current), { nativeTools: { [record.id]: [...record.nativeTools] } }) };
}

export async function resolveSessionNetworkScope(session: SessionGrant, narrowedTo?: readonly string[]): Promise<Bound | null> {
  return (await sessionAgentGrants(session, narrowedTo)).bound;
}

/**
 * A requested sandbox is an enforcement requirement. Unsupported routes,
 * partial action restrictions and unresolved policy fail closed; guards do
 * not silently replace sandbox enforcement.
 */
export async function resolveEgressSandbox(
  session: SessionGrant,
  agent: { provider: string; model?: string | undefined; modelProvider?: string | undefined },
): Promise<EgressPolicy | undefined> {
  try {
    const networkScope = (await resolveSessionNetworkScope({ ...session, provider: agent.provider }))?.network;
    if (networkScope?.enforce !== "sandbox") return undefined;
    const sandbox: EgressPolicy = { allowDomains: networkScope.allowDomains ?? [] };
    if (!supportsEgressSandbox(agent.provider, agent.model, agent.modelProvider)) {
      throw new Error("Requested egress sandbox: this harness or model endpoint cannot enforce it");
    }
    const actions = networkScope.actions ?? [];
    if (!canEnforceInSandbox(actions)) {
      throw new Error("Requested network action restrictions cannot be enforced by the egress sandbox; its proxy filters hostnames, not individual HTTP methods");
    }
    log.info("sandbox.enabled", { sessionId: session.id, allowedDomains: sandbox.allowDomains, actions });
    return sandbox;
  } catch (err) {
    log.error("sandbox.scope_resolution_failed", {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
