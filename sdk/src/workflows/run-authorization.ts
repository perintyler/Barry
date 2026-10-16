import {
  approveWorkflowBounds,
  assertBoundDelegation,
  boundFingerprint,
} from "../bounds/workflow-bounds.js";
import { resolveToolCallBounds, type ToolCallBounds } from "../bounds/resolve-bound.js";
import type { Bound, ToolDescriptor } from "../bounds/types.js";
import type { RunRequest, RunApproval } from "./approvals.js";

/** Application dependencies are supplied; importing workflows never discovers Barry. */
export interface RunBoundSources {
  catalog(): Promise<{ traits?: Record<string, unknown>; tools: ToolDescriptor[] }>;
  identity(id: string): Promise<{ bound: Bound | null } | undefined>;
  boundByName: (name: string) => Promise<Bound | undefined>;
  mayRunAs(principal: string, identity: string | undefined): Promise<boolean>;
  operator(principal: string): boolean;
}
async function identities(options: RunBoundSources, request: RunRequest, principal: string) {
  if (!(await options.mayRunAs(principal, request.identity))) {
    throw new Error("run-as identity is not authorized");
  }
  const authorizer = options.operator(principal) ? undefined : await options.identity(principal);
  if (!options.operator(principal) && !authorizer) {
    throw new Error("authorizing identity is unavailable");
  }
  const identity = request.identity
    ? request.identity === principal
      ? (authorizer ?? (await options.identity(request.identity)))
      : await options.identity(request.identity)
    : undefined;
  if (request.identity && !identity) throw new Error("unknown run identity");
  return { identity, authorizer };
}
async function resolveLegacyTraitsToBagsAndBounds(
  bags: readonly string[] | undefined,
  bounds: readonly string[] | undefined,
  traits: readonly string[] | undefined,
  tools: readonly ToolDescriptor[],
  catalogTraits?: Record<string, unknown>,
  boundByName?: (name: string) => Promise<Bound | undefined>,
): Promise<{
  bags: string[];
  bounds: (Bound | string)[];
}> {
  const traitList = traits ?? [];
  const hasCatalogTraits =
    traitList.length > 0 &&
    catalogTraits !== undefined &&
    Object.keys(catalogTraits).length > 0;
  const knownBagNames = new Set(tools.map((t) => t.namespace));
  if (bags !== undefined && !hasCatalogTraits) {
    const resolvedBags: string[] = [];
    const resolvedBounds: (Bound | string)[] = [...(bounds ?? [])];
    for (const entry of bags) {
      if (entry.endsWith(":read") && entry.length > ":read".length) {
        const bagName = entry.slice(0, -":read".length);
        if (!resolvedBags.includes(bagName)) resolvedBags.push(bagName);
        if (!resolvedBounds.includes(entry)) resolvedBounds.push(entry);
        continue;
      }
      if (!knownBagNames.has(entry) && boundByName) {
        const namedBound = await boundByName(entry);
        if (namedBound) {
          if (!resolvedBounds.includes(entry)) resolvedBounds.push(entry);
          continue;
        }
      }
      if (!resolvedBags.includes(entry)) resolvedBags.push(entry);
    }
    return {
      bags: resolvedBags,
      bounds: resolvedBounds,
    };
  }
  if (traitList.length === 0) {
    return {
      bags: [],
      bounds: [...(bounds ?? [])],
    };
  }
  const resolvedBags: string[] = [];
  const resolvedBounds: (Bound | string)[] = [...(bounds ?? [])];
  for (const entry of traitList) {
    const traitDef = catalogTraits?.[entry] as
      | { namespaces?: readonly string[]; access?: "read" | "write"; bound?: Bound | null }
      | undefined;
    if (traitDef && typeof traitDef === "object") {
      for (const ns of traitDef.namespaces ?? []) {
        if (!resolvedBags.includes(ns)) resolvedBags.push(ns);
        if (traitDef.access === "read") {
          const readBound = `${ns}:read`;
          if (!resolvedBounds.includes(readBound)) resolvedBounds.push(readBound);
        }
      }
      if (traitDef.bound) {
        if (!traitDef.namespaces?.length) {
          if (!resolvedBounds.includes(entry)) resolvedBounds.push(entry);
        } else {
          resolvedBounds.push(traitDef.bound);
        }
      }
      continue;
    }
    if (entry.endsWith(":read") && entry.length > ":read".length) {
      const bagName = entry.slice(0, -":read".length);
      if (!knownBagNames.has(bagName)) {
        throw new Error(
          `PolicyRevoked: legacy trait "${entry}" no longer exists; reauthorize run with bags and bounds`,
        );
      }
      if (!resolvedBags.includes(bagName)) resolvedBags.push(bagName);
      if (!resolvedBounds.includes(entry)) resolvedBounds.push(entry);
    } else if (knownBagNames.has(entry)) {
      if (!resolvedBags.includes(entry)) resolvedBags.push(entry);
    } else if (boundByName && (await boundByName(entry))) {
      if (!resolvedBounds.includes(entry)) resolvedBounds.push(entry);
    } else {
      throw new Error(
        `PolicyRevoked: legacy trait "${entry}" no longer exists; reauthorize run with bags and bounds`,
      );
    }
  }
  return {
    bags: resolvedBags,
    bounds: resolvedBounds,
  };
}

export function createRunAuthorization(options: RunBoundSources) {
  return async (request: RunRequest, principal: string, delegator?: ToolCallBounds) => {
    const { identity, authorizer } = await identities(options, request, principal);
    if (!options.operator(principal) && (!delegator || delegator.identity !== principal)) {
      throw new Error("verified delegation context required");
    }
    const catalog = await options.catalog();
    const sel = await resolveLegacyTraitsToBagsAndBounds(
      request.bags,
      request.bounds,
      request.traits,
      catalog.tools,
      catalog.traits,
      options.boundByName,
    );
    const scope = await approveWorkflowBounds({
      identity: request.identity,
      harness: request.harness,
      bags: sel.bags,
      traitNames: request.traits,
      tools: catalog.tools,
      bounds: [...sel.bounds, identity?.bound, authorizer?.bound, delegator?.bound],
      boundByName: options.boundByName,
    });
    if (!options.operator(principal)) assertBoundDelegation(scope, delegator!, catalog.tools);
    return scope;
  };
}

/** Reevaluate the recorded delegation basis; never substitute current identity defaults. */
export function createRunBoundRefresh(options: RunBoundSources) {
  return async (request: RunRequest, principal: string, basis?: RunApproval["delegation"]) => {
    const { identity, authorizer } = await identities(options, request, principal),
      catalog = await options.catalog();
    let delegator: ToolCallBounds | undefined;
    if (!options.operator(principal)) {
      if (!basis || basis.identity !== principal) {
        throw new Error("recorded delegation basis is unavailable");
      }
      const basisSel = await resolveLegacyTraitsToBagsAndBounds(
        basis.bags,
        basis.bounds,
        basis.traits,
        catalog.tools,
        catalog.traits,
        options.boundByName,
      );
      delegator = await resolveToolCallBounds({
        identity: principal,
        bags: basisSel.bags,
        harness: basis.harness,
        tools: catalog.tools,
        bounds: [...basisSel.bounds, authorizer?.bound],
        boundByName: options.boundByName,
      });
    }
    const sel = await resolveLegacyTraitsToBagsAndBounds(
      request.bags,
      request.bounds,
      request.traits,
      catalog.tools,
      catalog.traits,
      options.boundByName,
    );
    const scope = await approveWorkflowBounds({
      identity: request.identity,
      harness: request.harness,
      bags: sel.bags,
      traitNames: request.traits,
      tools: catalog.tools,
      bounds: [...sel.bounds, identity?.bound, authorizer?.bound, delegator?.bound],
      boundByName: options.boundByName,
    });
    if (!delegator) return scope;
    const tools = Object.fromEntries(
      Object.entries(scope.tools).filter(([id]) => delegator.allowedToolIds.includes(id)),
    );
    const contracts = Object.fromEntries(
      Object.entries(scope.contracts ?? {}).filter(([id]) => Object.hasOwn(tools, id)),
    );
    const { fingerprint: _fingerprint, ...evidence } = scope;
    const value = { ...evidence, tools, contracts };
    return { ...value, fingerprint: boundFingerprint(value) };
  };
}
