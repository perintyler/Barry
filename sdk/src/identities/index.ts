import { parseBounds, inheritEntries, serializeEntries, type IdentityEntries, type BoundEntry } from "./entries.js";
export * from "./entries.js";
import { mergeAdapters, type IdentityAdapters } from "./adapters.js";
export * from "./adapters.js";
export * from "./retired.js";
import { parseVaultName, mergeSecretBindings, type SecretBindings } from "./secrets.js";
export { parseVaultName, bindSecretReferences, mergeSecretBindings, SecretReferenceSchema, type SecretReference, type SecretBinding, type SecretBindings } from "./secrets.js";
import { mergeBagConfiguration, requiredIdentityBags, optionalIdentityBags, type IdentityBagConfiguration } from "./bags.js";
export { parseIdentityBags, serializeIdentityBags, mergeBagConfiguration, requiredIdentityBags, optionalIdentityBags, type IdentityBags, type IdentityBagConfiguration, type ToolVisibility } from "./bags.js";
import { mergeBounds, type Bound } from "../bounds/index.js";
/** An identity is reusable configuration, never a process or inheritance chain. */
export interface Identity { id: number; name: string; metadata: IdentityDefinition }
export interface IdentityDefinition {
  inherits?: string;
  secrets?: SecretBindings;
  bag_configs?: Record<string, IdentityBagConfiguration>;
  vault?: string;
  ui?: string;
  bounds?: IdentityEntries; bags?: string[]; bound?: Record<string, unknown>; scope?: Record<string, unknown>;
  adapters?: IdentityAdapters;
  status_notify?: { tool: string; target?: string };
  tool_discovery?: "provider" | "barry";
}

function assertCredentialReferences(metadata: IdentityDefinition): void {
  if (metadata.vault !== undefined) parseVaultName(metadata.vault);
  for (const key of ["env", "env_file"]) {
    if (Object.hasOwn(metadata, key) && (metadata as Record<string, unknown>)[key] !== undefined) {
      throw new Error(`Identity ${key} is retired; declare credential references under secrets instead`);
    }
  }
}

/**
 * Merge a child identity with its parent baseline. Child fields take
 * precedence; collections are unioned; bounds accumulate.
 *
 * Except the vault, which is never inherited. The parent's secret
 * declarations are — a vault-backed one names an item, and the child reads it
 * from the vault its own identity.yaml sets. An identity without a vault of
 * its own has none, rather than silently opening its parent's.
 */
export function mergeInheritedIdentity(parent: IdentityDefinition, child: IdentityDefinition): IdentityDefinition {
  assertCredentialReferences(parent);
  assertCredentialReferences(child);
  const bags = Array.from(new Set([...(parent.bags ?? []), ...(child.bags ?? [])]));
  const childSelectedBags = new Set(child.bags ?? []);
  const bag_configs: Record<string, IdentityBagConfiguration> = {};
  for (const bag of bags) {
    const parentConfig = parent.bag_configs?.[bag];
    let childConfig = child.bag_configs?.[bag];
    if (parentConfig?.optional && childSelectedBags.has(bag) && childConfig?.optional === undefined) {
      childConfig = { ...childConfig, optional: false };
    }
    const configuration = mergeBagConfiguration(parentConfig, childConfig);
    if (Object.keys(configuration).length) bag_configs[bag] = configuration;
  }
  const bounds = serializeEntries(inheritEntries(parseBounds(parent.bounds), parseBounds(child.bounds)));

  const parentBound = parent.bound ?? parent.scope;
  const childBound = child.bound ?? child.scope;
  let bound: Record<string, unknown> | undefined;
  if (parentBound && childBound) {
    const merged = mergeBounds(parentBound, childBound);
    bound = (merged ?? undefined) as Record<string, unknown> | undefined;
  } else if (childBound) {
    bound = childBound;
  } else if (parentBound) {
    bound = parentBound;
  }

  const { vault: _parentVault, ...inherited } = parent;
  return {
    ...inherited,
    ...child,
    bags: bags.length > 0 ? bags : undefined,
    bag_configs: Object.keys(bag_configs).length ? bag_configs : undefined,
    secrets: mergeSecretBindings(parent.secrets, child.secrets),
    bound,
    bounds: bounds.length > 0 ? bounds : undefined,
    adapters: mergeAdapters(parent.adapters ?? {}, child.adapters ?? {}),
    vault: child.vault,
    status_notify: child.status_notify ?? parent.status_notify,
    tool_discovery: child.tool_discovery ?? parent.tool_discovery,
    ui: child.ui ?? parent.ui,
  };
}
export interface ResolvedIdentityConfig {
  vault: IdentityDefinition["vault"] | undefined;
  ui?: string;
  bounds: BoundEntry[];
  bags: string[];
  bag_configs: Record<string, IdentityBagConfiguration>;
  secrets: SecretBindings;
  /** Legacy inline restriction, kept until doctor names it. */
  bound: Bound | undefined;
  adapters: IdentityAdapters;
  status_notify: IdentityDefinition["status_notify"] | undefined;
}

export function resolveIdentityConfig(
  meta: IdentityDefinition,
  options?: { resolveParent?: (name: string) => IdentityDefinition | undefined },
  visited?: Set<string>,
): ResolvedIdentityConfig {
  assertCredentialReferences(meta);
  let effective = meta;
  if (meta.inherits && options?.resolveParent) {
    const seen = visited ?? new Set<string>();
    if (seen.has(meta.inherits)) {
      throw new Error(`Circular inheritance detected: "${meta.inherits}"`);
    }
    seen.add(meta.inherits);
    const parent = options.resolveParent(meta.inherits);
    if (!parent) {
      throw new Error(`Parent identity "${meta.inherits}" not found`);
    }
    let parentMeta = parent;
    if (parent.inherits) {
      const parentResolved = resolveIdentityConfig(parent, options, seen);
      parentMeta = {
        ...parent,
        bags: parentResolved.bags,
        bag_configs: parentResolved.bag_configs,
        secrets: parentResolved.secrets,
        bounds: serializeEntries(parentResolved.bounds),
        bound: parentResolved.bound as Record<string, unknown> | undefined,
        adapters: parentResolved.adapters,
        vault: parentResolved.vault,
        status_notify: parentResolved.status_notify,
        ui: parentResolved.ui,
      };
    }
    effective = mergeInheritedIdentity(parentMeta, meta);
  }

  // A lone bound still goes through mergeBounds: it normalizes shape, and the
  // enforcement layer expects that canonical form.
  const inlineRaw = effective.bound ?? effective.scope;
  const inline = inlineRaw && Object.keys(inlineRaw).length > 0 ? inlineRaw : undefined;

  return {
    vault: effective.vault ?? undefined,
    bounds: parseBounds(effective.bounds),
    bags: Array.isArray(effective.bags) ? [...effective.bags] : [],
    bag_configs: effective.bag_configs ?? {},
    secrets: mergeSecretBindings({}, effective.secrets),
    bound: inline ? mergeBounds(null, inline) ?? undefined : undefined,
    adapters: mergeAdapters({}, effective.adapters ?? {}),
    status_notify: effective.status_notify?.tool ? effective.status_notify : undefined,
    ui: effective.ui,
  };
}

export const Identities = { resolve: resolveIdentityConfig };
export * from "./types.js";
export * from "./changes.js";
