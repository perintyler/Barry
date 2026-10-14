import { resolveHarnessNames } from "@barry-rocks/sdk/internal/traits";
import { requiredNames, optionalNames, defaultHarness, FALLBACK_HARNESS } from "@barry-rocks/sdk/internal/identities";
import { resolveSessionPolicy } from "@barry-rocks/sdk/internal/sessions";
import { BarryError } from "@barry-rocks/sdk";
import { baseIdentityConfig } from "../store/identity-files.js";
import { ALLOW_DOMAINS_NEEDS_SANDBOX, nativeToolStatus, expandTraitNames, filterToolsQualified, qualifyToolId, type Access, type ExecutionContext, type ToolMeta, type Bound } from "@barry-rocks/sdk/bounds";
import { collectToolMeta, type ToolMetaEntry } from "@barry-rocks/sdk/internal/tools";
import type { GrantSelection, Grants, Tool } from "@barry-rocks/sdk";
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { Identities, resolveIdentityConfig, type IdentityRecord, type ResolvedIdentityConfig } from "../store/identities.js";
import { Traits, type TraitInfo } from "./traits.js";
import { Bounds, type BoundRecord } from "./bounds.js";

export type SessionPolicyInput = {
  identityId?: number | null;
  traitNames: readonly string[];
  harness?: string;
  bounds?: readonly string[];
  inlineBound?: Bound | null;
  includeIdentityTraits?: boolean;
  includeDefaultTraits?: boolean;
};

/** What composing a session's policy reads: the identity, its config, the traits, and named bounds. */
export interface SessionPolicyReaders {
  identity(id: number): Promise<IdentityRecord | undefined>;
  config(identity: IdentityRecord): ResolvedIdentityConfig;
  traits(): Promise<TraitInfo[]>;
  bounds(): Promise<BoundRecord[]>;
  base?(): ResolvedIdentityConfig | undefined;
  /** A harness by the id its installed adapter answers to (`claude` is `claude-code`). */
  harness?(id: string): InstalledAdapter | undefined;
  harnesses?(): readonly InstalledAdapter[];
}

let installedAdapters: ReturnType<ReturnType<typeof loadAdapters>["installed"]> | null = null;
function installedHarnesses(): readonly InstalledAdapter[] {
  installedAdapters ??= loadAdapters({ file: barryAdaptersPath() }).installed();
  return installedAdapters;
}
function installedHarness(id: string): InstalledAdapter | undefined {
  installedAdapters ??= loadAdapters({ file: barryAdaptersPath() }).installed();
  return findInstalled(installedAdapters, id);
}

function directTrait(name: string, grant: { namespaces?: string[]; tools?: string[]; access?: Access }): TraitInfo {
  return {
    name, description: null, namespaces: grant.namespaces ?? [], tools: grant.tools ?? [], access: grant.access ?? "read",
    skills: [], instructions: [], bound: {}, boundNames: [], bag: null,
  };
}

function toolOf(meta: ToolMeta | ToolMetaEntry): Tool {
  const bag = "bag" in meta ? meta.bag : undefined;
  const description = "description" in meta ? meta.description : undefined;
  return {
    name: meta.toolName,
    namespace: meta.namespace,
    bag: bag ?? null,
    access: meta.access,
    ...(description ? { description } : {}),
  };
}

/**
 * A session's grants and restrictions from one identity/session policy
 * snapshot, over the given readers. Each read happens when the policy is
 * composed, so a reader's current answer is what counts.
 */
export function sessionPolicy(readers: SessionPolicyReaders) {
  async function catalogs(config?: ResolvedIdentityConfig, identityName = "barry") {
    const base = readers.base?.();
    const traits: Record<string, TraitInfo> = Object.fromEntries((await readers.traits()).map(trait => [trait.name, trait]));
    const boundRows = await readers.bounds();
    const namedBounds = new Map(boundRows.map(row => [row.name, row.bound]));
    for (const source of [base, config]) {
      for (const entry of source?.traits ?? []) {
        if (!entry.trait) continue;
        if (traits[entry.name]?.bag) throw new Error(`Identity ${identityName}: trait ${entry.name} is owned by bag ${traits[entry.name].bag}`);
        const { bags, ...trait } = entry.trait;
        traits[entry.name] = { ...trait, name: entry.name, namespaces: bags, tools: [], skills: trait.skills ?? [], instructions: trait.instructions ?? [], bound: trait.bound ?? {}, boundNames: trait.boundNames ?? [], bag: null };
      }
      for (const entry of source?.bounds ?? []) {
        if (!entry.bound) continue;
        const owner = boundRows.find(row => row.name === entry.name)?.bag;
        if (owner) throw new Error(`Identity ${identityName}: bound ${entry.name} is owned by bag ${owner}`);
        namedBounds.set(entry.name, entry.bound);
      }
    }
    return { traits, namedBounds };
  }

  async function identityTraits(identity: IdentityRecord) {
    const config = readers.config(identity);
    const { traits } = await catalogs(config, identity.name);
    const named = defaultHarness(config.adapters) ?? FALLBACK_HARNESS;
    const adapter = readers.harness?.(named);
    const convention = { bag: adapter?.bag?.manifest.name, bags: (readers.harnesses?.() ?? []).flatMap(record => record.bag ? [record.bag.manifest.name] : []) };
    const result: { name: string; optional: boolean; trait: TraitInfo }[] = [];
    for (const entry of config.traits) {
      const resolved = resolveHarnessNames([entry.name], new Set(Object.keys(traits)), convention, "trait").names[0];
      if (resolved) result.push({ name: entry.name, optional: entry.optional, trait: traits[resolved] });
    }
    if (config.bag_grant === "identity") for (const bag of config.bags) {
      if (traits[bag] && !result.some(entry => entry.name === bag)) result.push({ name: bag, optional: false, trait: traits[bag] });
    }
    return result;
  }

  /**
   * Everything a session of `identity` (none: a session with no identity) is
   * granted, given what it selects on top. `tools` decides over the given tool
   * metadata; by default, every tool the registered bags declare.
   */
  async function grants(identity: IdentityRecord | undefined, selection: GrantSelection, tools?: readonly (ToolMeta | ToolMetaEntry)[]): Promise<Grants> {
    const config = identity ? readers.config(identity) : undefined;
    // The harness a session of the identity runs on, as the runtime picks it:
    // the session's own, then the identity's default, then Barry's. An
    // identity's traits can differ per harness, so they cannot resolve without one.
    const named = selection.harness ?? (config ? defaultHarness(config.adapters) ?? FALLBACK_HARNESS : undefined);
    const record = named ? readers.harness?.(named) : undefined;
    const adapter = record;
    const harness = adapter?.id ?? named;
    if (identity?.metadata && "bound_id" in identity.metadata && (identity.metadata as Record<string, unknown>).bound_id != null) throw new BarryError("conflict", `Identity ${identity.name} still carries bound_id`, "barry doctor --fix");
    const base = readers.base?.();
    const { traits, namedBounds } = await catalogs(config, identity?.name);
    const convention = { bag: adapter?.bag?.manifest.name, bags: (readers.harnesses?.() ?? []).flatMap(record => record.bag ? [record.bag.manifest.name] : []) };
    const resolveTraits = (names: readonly string[]): string[] =>
      resolveHarnessNames(names, new Set(Object.keys(traits)), convention, "trait").names;
    const resolveBound = (name: string) => {
      const result = resolveHarnessNames([name], new Set(namedBounds.keys()), convention, "bound");
      if (result.ungranted.length) throw new Error(`unknown selected bound ${name} on ${harness ?? "this harness"}`);
      return namedBounds.get(result.names[0]);
    };
    const disabledTraits = new Set(selection.identityTraits === false ? [] : optionalNames(config?.traits ?? []));
    const disabledBounds = new Set(selection.identityTraits === false ? [] : optionalNames(config?.bounds ?? []));
    // A default this installation names but cannot resolve is dropped (it
    // grants nothing, so it is not one of the session's traits), but the drop
    // is recorded rather than swallowed: a base default that fails to resolve
    // left the session quietly missing a capability with no diagnostic (POL-18).
    const droppedDefaults: string[] = [];
    const defaults = selection.defaults === false ? [] : requiredNames(base?.traits ?? []).filter(name => !disabledTraits.has(name)).flatMap(name => {
      try { return resolveTraits([name]); } catch (err) {
        droppedDefaults.push(`default trait ${name} could not be resolved and was dropped: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    });
    const sessionTraits = resolveTraits(selection.traits ?? []);
    const identityTraits = resolveTraits(selection.identityTraits === false ? [] : requiredNames(config?.traits ?? []));
    const bounds: (Bound | null | undefined)[] = [
      ...requiredNames(base?.bounds ?? []).filter(name => !disabledBounds.has(name)).map(resolveBound),
      ...requiredNames(config?.bounds ?? []).map(resolveBound),
      ...(selection.bounds ?? []).map(resolveBound), config?.bound, selection.inlineBound,
    ];
    const policy = await resolveSessionPolicy({
      // A default this installation lacks grants nothing, so it is not one of the session's traits.
      defaults,
      session: sessionTraits,
      identity: selection.identityTraits === false || !config ? undefined : { ...config, traits: identityTraits },
      traits,
      ...(harness ? { harness } : {}),
      bounds,
      boundByName: async (name) => {
        try { return resolveBound(name); } catch { return undefined; }
      },
    });
    // An allowlist only the egress sandbox can enforce: a stored inline bound
    // never met the schema that refuses one without it, so the merge is checked.
    if (policy.bound?.network?.allowDomains !== undefined && policy.bound.network.enforce !== "sandbox") {
      throw new Error(ALLOW_DOMAINS_NEEDS_SANDBOX);
    }
    // Namespaces and tools granted directly ride as traits of their own, so
    // the bound and the access rules apply to them as to any other grant.
    const direct: TraitInfo[] = [];
    if (selection.namespaces?.length) direct.push(directTrait("__direct_namespaces", { namespaces: [...selection.namespaces] }));
    if (selection.tools?.length) direct.push(directTrait("__direct_tools", { tools: [...selection.tools] }));
    for (const trait of direct) traits[trait.name] = trait;
    const traitNames = [...policy.traits, ...direct.map((trait) => trait.name)];
    const granted = expandTraitNames(traitNames, traits, harness).flatMap((name) => (traits[name] ? [traits[name]] : []));
    const union = (field: "namespaces" | "skills" | "instructions") => [...new Set(granted.flatMap((trait) => trait[field] ?? []))];
    let candidates = tools;
    if (!candidates) {
      try {
        candidates = await collectToolMeta();
      } catch (err) {
        if (err instanceof Error && err.name === "RegistrySnapshotError") candidates = [];
        else throw err;
      }
    }
    const allowed = new Set(filterToolsQualified([...candidates], traitNames, traits, policy.bound ?? undefined, harness));
    const nativeTools: Tool[] = [];
    if (adapter) {
      const status = nativeToolStatus(granted, policy.bound, adapter, selection.mode ?? adapter.defaultMode);
      for (const name of adapter.nativeTools) {
        if (!status.allowed.includes(name) && !status.refused[name] && !status.uncontrolled[name]) continue;
        nativeTools.push({ name, namespace: adapter.id, bag: null,
          access: granted.some(trait => trait.access === "readwrite" && trait.nativeTools?.[adapter.id]?.includes(name)) ? "write" : "read",
          ...(status.refused[name] ? { unavailable: status.refused[name] } : {}),
          ...(status.uncontrolled[name] ? { uncontrolled: status.uncontrolled[name] } : {}),
        });
      }
    }
    return {
      // The direct grants ride as synthetic traits (POL-14): surfaced here so
      // `session show` reports a namespace or tool a session row granted
      // without any trait existing for it, rather than it being invisible.
      traits: traitNames,
      bound: policy.bound,
      namespaces: union("namespaces"),
      tools: [...candidates.filter((meta) => allowed.has(qualifyToolId(meta.namespace, meta.toolName))).map(toolOf), ...nativeTools],
      skills: union("skills").map((name) => ({ name })),
      instructions: union("instructions").map((name) => ({ name })),
      ...(droppedDefaults.length ? { warnings: droppedDefaults } : {}),
    };
  }

  async function context(input: SessionPolicyInput, tools: ToolMeta[]): Promise<ExecutionContext> {
    const identity = input.identityId ? await readers.identity(input.identityId) : undefined;
    if (input.identityId != null && !identity) throw new Error(`unknown session identity id ${input.identityId}`);
    const granted = await grants(identity, {
      traits: input.traitNames,
      ...(input.harness ? { harness: input.harness } : {}),
      bounds: input.bounds ?? [],
      inlineBound: input.inlineBound ?? null,
      defaults: input.includeDefaultTraits !== false,
      identityTraits: input.includeIdentityTraits !== false,
    }, tools);
    return { traits: granted.traits, bound: granted.bound, allowedToolIds: granted.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)), harness: input.harness };
  }
  const bound = async (input: SessionPolicyInput): Promise<Bound | null> => (await context(input, [])).bound;
  return { grants, context, bound, identityTraits };
}

const fromStore = sessionPolicy({
  identity: (id) => Identities.get(id),
  config: resolveIdentityConfig,
  traits: () => Traits.list(),
  bounds: () => Bounds.list(),
  base: baseIdentityConfig,
  harness: installedHarness,
  harnesses: installedHarnesses,
});

/** Resolve grants and restrictions from one identity/session policy snapshot. */
export const resolveIdentitySessionContext = fromStore.context;
export const resolveIdentitySessionBound = fromStore.bound;
export const grantsFromStore = fromStore.grants;

export const identityTraitsFromStore = fromStore.identityTraits;
