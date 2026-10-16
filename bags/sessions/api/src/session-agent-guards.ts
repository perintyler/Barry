/**
 * The restrictions every Barry-driven agent runs under, beyond the MCP tools
 * its session has enabled: which of its harness's own native tools it loses,
 * and the network sandbox its bound calls for.
 *
 * Shared by a session's agent (session-runtime) and a subagent run for one
 * (the action executor), so a subagent can never be looser than the session
 * that started it because the two computed the same rule differently.
 */

import {
  BoundSchema,
  approvedBoundsSchema,
  boundFingerprint,
  boundHasContent,
  extractSandboxAllowedDomains,
  mergeBounds,
  parseNetworkRule,
  resolveNativeTools,
  type Bound,
  type NativeToolResolution,
} from "@barry-rocks/sdk/bounds";
import { Barry } from "@barry-rocks/sdk";
import { canEnforceInSandbox, type EgressPolicy } from "@barry-rocks/sdk/sessions";
import { installedModels, routedVendorOf } from "@barry-rocks/sdk/adapters/models";
import { getDescribeAdapter } from "./agent-runtime.js";
import { createLogger } from "@barry-rocks/sdk/logging";
import { getSessionRecord } from "./db.js";

// The session runtime's logger, so the sandbox events keep the name every
// existing log query and alert already looks for.
const log = createLogger("session-runtime");

/** The session an agent acts for, and the harness it runs on. */
export interface SessionBoundsRecord {
  id: string;
  provider?: string;
  workflowScoped?: boolean;
  identityId?: number | null;
}

/**
 * Resolve the effective `Bound` for a session, honoring its pinned `row.bound`
 * ([DESIGN.md §7.1.4]) and any approved workflow bound ceiling.
 */
export async function sessionBound(
  session: SessionBoundsRecord,
  extraBounds?: readonly (Bound | string)[],
): Promise<Bound | null> {
  const dbSession = await getSessionRecord(session.id);
  const record = getDescribeAdapter()?.(session.provider ?? "");
  const identityRef = dbSession?.identity_id ?? null;

  let current: Bound | null = null;
  if (dbSession?.bound !== null && dbSession?.bound !== undefined) {
    current = BoundSchema.parse(dbSession.bound);
  } else if (dbSession) {
    try {
      current = await Barry.bound(identityRef, dbSession.bounds ?? []);
    } catch (error) {
      if (error instanceof Error && error.message.includes('has no subject for "identities"')) {
        current = {};
      } else {
        throw error;
      }
    }
  } else {
    try {
      current = await Barry.bound(null, []);
    } catch (error) {
      if (error instanceof Error && error.message.includes('has no subject for "identities"')) {
        current = {};
      } else {
        throw error;
      }
    }
  }

  if (extraBounds && extraBounds.length > 0) {
    const resolvedExtra = await resolveExtraBounds(identityRef, extraBounds);
    current = mergeBounds(current, resolvedExtra);
  }

  const workflowBoundRaw =
    dbSession?.metadata?.workflow_bound;
  if (workflowBoundRaw === undefined && !session.workflowScoped) {
    return boundHasContent(current) ? current : null;
  }
  if (workflowBoundRaw === undefined) {
    throw new Error("workflow session identity, harness or execution ceiling is invalid");
  }

  const approved = approvedBoundsSchema.parse(workflowBoundRaw);
  const { fingerprint, ...evidence } = approved;
  let fingerprintValid = boundFingerprint(evidence) === fingerprint;
  if (!fingerprintValid && approved.bags) {
    const { traits: _omitted, ...withoutTraits } = evidence;
    fingerprintValid = boundFingerprint(withoutTraits) === fingerprint;
  }
  const identityId = dbSession?.identity_id;
  if (
    !approved.identity ||
    !identityId ||
    dbSession?.metadata?.workflow_identity_id !== identityId ||
    !fingerprintValid ||
    (approved.harness && approved.harness !== record?.id)
  ) {
    throw new Error("workflow session identity, harness or execution ceiling is invalid");
  }
  if (!record) {
    throw new Error("workflow harness native-tool inventory is unavailable");
  }

  // Workflow sessions receive only the Barry tools approved for their step, not
  // a harness's ambient native tool inventory.
  const nativeToolsList = [...(record.tools ?? [])];
  const nativeDenialBound: Bound = {
    tools: { deny: nativeToolsList.map((tool) => `${record.id}:${tool}`) },
  };
  return mergeBounds(mergeBounds(approved.bound, current), nativeDenialBound);
}

async function resolveExtraBounds(
  identityRef: number | null,
  extraBounds: readonly (Bound | string)[],
): Promise<Bound | null> {
  const inlineOnly = extraBounds.every((b) => typeof b === "object" && b !== null);
  if (inlineOnly) {
    let acc: Bound | null = null;
    for (const entry of extraBounds) {
      acc = mergeBounds(acc, BoundSchema.parse(entry));
    }
    return acc;
  }
  return Barry.bound(identityRef, extraBounds);
}

/**
 * Resolve the native tool ruling (`allowed`, `denied`, `refused`, `uncontrolled`,
 * `conflicts`) for a session on its harness.
 */
export async function resolveSessionNativeTools(
  session: SessionBoundsRecord,
  options?: { bags?: readonly string[]; bounds?: readonly (Bound | string)[]; bound?: Bound | Record<string, unknown> | null },
): Promise<NativeToolResolution> {
  const dbSession = await getSessionRecord(session.id);
  const isExplicit = Boolean(
    options?.bags !== undefined ||
      dbSession?.metadata?.execution_context ||
      dbSession?.metadata?.explicit_bags,
  );
  const identityRef = isExplicit ? null : (dbSession?.identity_id ?? session.identityId ?? null);
  const activeBags = options?.bags ?? dbSession?.bags;
  const extraBounds = options?.bound
    ? [...(options?.bounds ?? []), BoundSchema.parse(options.bound)]
    : options?.bounds;
  const bound = await sessionBound(session, extraBounds);
  const record = getDescribeAdapter()?.(session.provider ?? "");

  if (!record) {
    const hasExplicitNativeDenials = Boolean(
      bound?.tools?.deny?.some((pattern) => {
        const idx = pattern.indexOf(":");
        if (idx <= 0) return false;
        const prefix = pattern.slice(0, idx);
        const target = pattern.slice(idx + 1);
        return (
          prefix === session.provider &&
          target !== "*" &&
          target !== "read" &&
          target !== "write"
        );
      }),
    );
    if (hasExplicitNativeDenials) {
      throw new Error(`no installed adapter ruling for ${session.provider}`);
    }
    return { allowed: [], denied: [], refused: {}, uncontrolled: {}, conflicts: {} };
  }

  let tools: Awaited<ReturnType<typeof Barry.tools>> = [];
  try {
    tools = await Barry.tools(identityRef, activeBags, bound ?? undefined);
  } catch {
    tools = [];
  }
  return resolveNativeTools(bound, tools, record, "hosted");
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
 */
export function supportsEgressSandbox(provider: string, model?: string, modelProvider?: string): boolean {
  const record = getDescribeAdapter()?.(provider);
  if (!record) return false;
  const vendors = installedModels().vendors();
  const vendor = modelProvider ?? (model ? routedVendorOf(record, model, vendors)?.id : undefined);
  const routed = vendor && record.vendor && vendor !== record.vendor ? installedModels().endpoint(vendor, record.vendor) : undefined;
  return routed?.egressSandbox ?? record.modes.hosted?.egressSandbox ?? false;
}

/**
 * A requested sandbox is an enforcement requirement. Unsupported routes,
 * partial action restrictions and unresolved bounds fail closed; guards do
 * not silently replace sandbox enforcement.
 */
export async function resolveEgressSandbox(
  session: SessionBoundsRecord,
  agent: {
    provider: string;
    model?: string | undefined;
    modelProvider?: string | undefined;
    bounds?: readonly (Bound | string)[] | undefined;
  },
): Promise<EgressPolicy | undefined> {
  try {
    const bound = await sessionBound(
      { ...session, provider: agent.provider },
      agent.bounds,
    );
    const networkBound = bound?.network;
    if (networkBound?.enforce !== "sandbox") return undefined;

    if (!supportsEgressSandbox(agent.provider, agent.model, agent.modelProvider)) {
      throw new Error("Requested egress sandbox: this harness or model endpoint cannot enforce it");
    }

    const denyEntries = networkBound.deny ?? [];
    const deniedActions: string[] = [];
    for (const entry of denyEntries) {
      const parsed = parseNetworkRule(entry);
      if (parsed.kind === "action") {
        deniedActions.push(parsed.action);
      } else if (parsed.kind === "url") {
        throw new Error(
          "Requested network URL-path or method restrictions cannot be enforced by the egress sandbox; its proxy filters hostnames, not individual HTTP methods or paths",
        );
      }
    }
    for (const entry of networkBound.allow ?? []) {
      const parsed = parseNetworkRule(entry);
      if (parsed.kind === "action") {
        if (!canEnforceInSandbox([parsed.action])) {
          throw new Error(
            "Requested network action restrictions cannot be enforced by the egress sandbox; its proxy filters hostnames, not individual HTTP methods",
          );
        }
      } else if (
        parsed.kind === "url" &&
        (parsed.method !== null || (parsed.pathPattern !== "/**" && parsed.pathPattern !== "/*"))
      ) {
        throw new Error(
          "Requested network URL-path or method restrictions cannot be enforced by the egress sandbox; its proxy filters hostnames, not individual HTTP methods or paths",
        );
      }
    }
    if (!canEnforceInSandbox(deniedActions)) {
      throw new Error(
        "Requested network action restrictions cannot be enforced by the egress sandbox; its proxy filters hostnames, not individual HTTP methods",
      );
    }

    const allowDomains = extractSandboxAllowedDomains(networkBound);
    const sandbox: EgressPolicy = { allowDomains };
    log.info("sandbox.enabled", {
      sessionId: session.id,
      allowedDomains: sandbox.allowDomains,
      actions: deniedActions,
    });
    return sandbox;
  } catch (err) {
    log.error("sandbox.scope_resolution_failed", {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
