import type { Bound, ToolDescriptor } from "./types.js";
import { mergeBounds } from "./merge-bounds.js";
import { filterToolsQualified, qualifyToolId } from "./filter-tools.js";

export interface ToolCallBounds {
  identity?: string;
  bags?: string[];
  bounds?: string[];
  bound: Bound | null;
  allowedToolIds: string[];
  harness?: string;
}

/**
 * Combine a list of named and inline bounds into a single resolved `Bound`.
 */
export async function resolveBound(options: {
  bounds?: readonly (Bound | string | null | undefined)[];
  boundByName?: (name: string) => Promise<Bound | null | undefined> | Bound | null | undefined;
}): Promise<Bound | null> {
  let bound: Bound | null = null;
  const cache = new Map<string, Bound>();
  for (const entry of options.bounds ?? []) {
    if (!entry) continue;
    if (typeof entry === "string") {
      let resolved = cache.get(entry);
      if (!resolved) {
        if (options.boundByName) {
          resolved = (await options.boundByName(entry)) ?? undefined;
        }
        if (!resolved && entry.endsWith(":read") && entry.length > ":read".length) {
          const bagName = entry.slice(0, -":read".length);
          resolved = { tools: { deny: [`${bagName}:write`] } };
        }
        if (!resolved) throw new Error(`unknown selected bound ${entry}`);
        cache.set(entry, resolved);
      }
      bound = mergeBounds(bound, resolved);
    } else {
      bound = mergeBounds(bound, entry);
    }
  }
  return bound;
}

/** Resolve an execution ceiling from selected bags and bounds. */
export async function resolveToolCallBounds(options: {
  identity?: string;
  bags?: readonly string[];
  bagNames?: readonly string[];
  traitNames?: readonly string[];
  traits?: Record<
    string,
    { namespaces?: readonly string[]; access?: "read" | "write"; bound?: Bound | null } | undefined
  >;
  boundNames?: readonly string[];
  tools: ToolDescriptor[];
  harness?: string;
  boundByName: (name: string) => Promise<Bound | null | undefined>;
  bounds?: readonly (Bound | string | null | undefined)[];
}): Promise<ToolCallBounds> {
  const activeBags = options.bags ?? options.bagNames ?? options.traitNames ?? [];
  const normalizedBags: string[] = [];
  const impliedReadBounds: string[] = [];
  const inlineTraitBounds: Bound[] = [];
  for (const entry of activeBags) {
    const traitDef = options.traits?.[entry];
    if (traitDef) {
      for (const ns of traitDef.namespaces ?? []) {
        if (!normalizedBags.includes(ns)) normalizedBags.push(ns);
        if (traitDef.access === "read") {
          impliedReadBounds.push(`${ns}:read`);
        }
      }
      if (traitDef.bound) {
        inlineTraitBounds.push(traitDef.bound);
        if (!traitDef.namespaces?.length) {
          impliedReadBounds.push(entry);
        }
      }
      continue;
    }
    if (entry.endsWith(":read") && entry.length > ":read".length) {
      normalizedBags.push(entry.slice(0, -":read".length));
      impliedReadBounds.push(entry);
    } else {
      normalizedBags.push(entry);
    }
  }
  const stringBounds = (options.bounds ?? []).filter((b): b is string => typeof b === "string");
  const selectedBoundNames = [
    ...new Set([...impliedReadBounds, ...(options.boundNames ?? []), ...stringBounds]),
  ];
  const extraBounds: (Bound | string | null | undefined)[] = [
    ...impliedReadBounds,
    ...inlineTraitBounds,
    ...(options.boundNames ?? []),
    ...(options.bounds ?? []),
  ];
  const bound = await resolveBound({
    bounds: extraBounds,
    boundByName: options.boundByName,
  });
  const bagSet = new Set(normalizedBags);
  const candidateTools = options.tools.filter(
    (t) => bagSet.has(t.namespace) || (options.harness && t.namespace === options.harness),
  );
  const allowed = filterToolsQualified(candidateTools, bound);
  return {
    identity: options.identity,
    bags: [...normalizedBags],
    bounds: selectedBoundNames,
    bound,
    allowedToolIds: [...allowed],
    harness: options.harness,
  };
}

export function assertNodeAllowed(nodeId: string, bound?: Bound | null): void {
  if (
    bound?.nodes?.deny?.includes(nodeId) ||
    (bound?.nodes?.allow !== undefined && !bound.nodes.allow.includes(nodeId)) ||
    (bound?.nodes?.allowClauses?.length &&
      !bound.nodes.allowClauses.every((clause) => clause.includes(nodeId)))
  ) {
    throw new Error(`node access denied: ${nodeId}`);
  }
}

export function assertToolAllowed(
  context: ToolCallBounds,
  tool: Pick<ToolDescriptor, "namespace" | "toolName">,
  nodeId: string,
): void {
  assertNodeAllowed(nodeId, context.bound);
  if (!context.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName))) {
    throw new Error(`tool access denied: ${tool.namespace}:${tool.toolName}`);
  }
}

export function nativeToolDenials(
  bound: Bound | null | undefined,
  harness: string,
  inventory?: readonly string[],
  aliases: readonly string[] = [],
): string[] {
  const prefixes = [harness, ...aliases];
  const explicitHarnessDenied: string[] = [];
  const wildcardDenied: string[] = [];

  for (const pattern of bound?.tools?.deny ?? []) {
    const matchedPrefix = prefixes.find((prefix) => pattern.startsWith(`${prefix}:`));
    if (matchedPrefix) {
      const target = pattern.slice(matchedPrefix.length + 1);
      if (target === "*") continue;
      if (
        (target === "read" || target === "write") &&
        (inventory ? !inventory.includes(target) : harness !== "opencode" && harness !== "pi")
      ) {
        continue;
      }
      explicitHarnessDenied.push(target);
    } else if (pattern.startsWith("*:")) {
      const target = pattern.slice(2);
      if (target !== "read" && target !== "write" && target !== "*") {
        wildcardDenied.push(target.toLowerCase());
      }
    }
  }

  if (!inventory) {
    return [...new Set(explicitHarnessDenied)];
  }

  const unknown = explicitHarnessDenied.filter((tool) => !inventory.includes(tool));
  if (unknown.length) {
    throw new Error(`harness ${harness} has no native tools: ${unknown.join(", ")}`);
  }

  return inventory.filter(
    (tool) =>
      explicitHarnessDenied.includes(tool) || wildcardDenied.includes(tool.toLowerCase()),
  );
}

