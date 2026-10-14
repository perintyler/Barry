import { approveExecutionScope, assertScopeDelegation, scopeFingerprint } from "../bounds/execution-scope.js";
import type { ExecutionContext } from "../bounds/execution-context.js";
import { resolveExecutionContext } from "../bounds/execution-context.js";
import type { AgentTrait, Bound, ToolMeta } from "../bounds/types.js";
import type { RunRequest, RunGrant } from "./grants.js";

/** Application dependencies are supplied; importing workflows never discovers Barry. */
export interface RunPolicySources {
  catalog(): Promise<{ traits: Record<string, AgentTrait>; tools: ToolMeta[] }>;
  identity(id: string): Promise<{ bound: Bound | null } | undefined>;
  boundByName: (name: string) => Promise<Bound | undefined>;
  mayRunAs(principal: string, identity: string | undefined): Promise<boolean>;
  operator(principal: string): boolean;
}
async function identities(options: RunPolicySources, request: RunRequest, principal: string) {
  if (!await options.mayRunAs(principal, request.identity)) throw new Error("run-as identity is not authorized");
  const authorizer = options.operator(principal) ? undefined : await options.identity(principal);
  if (!options.operator(principal) && !authorizer) throw new Error("authorizing identity is unavailable");
  const identity = request.identity ? request.identity === principal ? authorizer ?? await options.identity(request.identity) : await options.identity(request.identity) : undefined;
  if (request.identity && !identity) throw new Error("unknown run identity");
  return { identity, authorizer };
}
export function createRunAuthorization(options: RunPolicySources) {
  return async (request: RunRequest, principal: string, delegator?: ExecutionContext) => {
    const { identity, authorizer } = await identities(options, request, principal);
    if (!options.operator(principal) && (!delegator || delegator.identity !== principal)) throw new Error("verified delegation context required");
    const catalog = await options.catalog();
    const scope = await approveExecutionScope({ identity: request.identity, harness: request.harness, traitNames: request.traits, ...catalog,
      bounds: [identity?.bound, authorizer?.bound, delegator?.bound], boundByName: options.boundByName });
    if (!options.operator(principal)) assertScopeDelegation(scope, delegator!, catalog.tools);
    return scope;
  };
}

/** Reevaluate the recorded delegation basis; never substitute current identity defaults. */
export function createRunScopeRefresh(options: RunPolicySources) {
  return async (request: RunRequest, principal: string, basis?: RunGrant["delegation"]) => {
    const { identity, authorizer } = await identities(options, request, principal), catalog = await options.catalog();
    let delegator: ExecutionContext | undefined;
    if (!options.operator(principal)) {
      if (!basis || basis.identity !== principal) throw new Error("recorded delegation basis is unavailable");
      delegator = await resolveExecutionContext({ identity: principal, traitNames: basis.traits, harness: basis.harness, ...catalog, bounds: [authorizer?.bound], boundByName: options.boundByName });
    }
    const scope = await approveExecutionScope({ identity: request.identity, harness: request.harness, traitNames: request.traits, ...catalog, bounds: [identity?.bound, authorizer?.bound, delegator?.bound], boundByName: options.boundByName });
    if (!delegator) return scope;
    const tools = Object.fromEntries(Object.entries(scope.tools).filter(([id]) => delegator.allowedToolIds.includes(id)));
    const contracts = Object.fromEntries(Object.entries(scope.contracts ?? {}).filter(([id]) => Object.hasOwn(tools, id)));
    const { fingerprint: _fingerprint, ...evidence } = scope;
    const value = { ...evidence, tools, contracts };
    return { ...value, fingerprint: scopeFingerprint(value) };
  };
}
