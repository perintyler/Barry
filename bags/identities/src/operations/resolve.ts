/**
 * Capability and bound resolution for an identity and a run's selection,
 * delegating to `Barry.tools` and `Barry.bound`.
 */
import {
  Barry,
  BarryError,
  type BagLike,
  type BagToolInput,
  type Bound,
  type Tool,
} from "@barry-rocks/sdk";
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { nativeToolsTakenBack, nativeToolDenials } from "@barry-rocks/sdk/bounds";
import type { ModeId } from "@barry-rocks/sdk/ids";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { expandCompositionSync, loadBags, loadRegistry } from "@barry-rocks/sdk/internal/bags";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import {
  FALLBACK_HARNESS,
  defaultHarness,
  optionalIdentityBags,
  optionalNames,
  parseIdentityBags,
  requiredIdentityBags,
  requiredNames,
} from "@barry-rocks/sdk/internal/identities";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { resolveIdentityConfig, type IdentityRecord, type ResolvedIdentityConfig } from "../store/identities.js";
import { baseIdentityConfig } from "../store/identity-files.js";
import { bounds } from "./bounds.js";

export interface ResolveSelection {
  /** Additional bags selected for the session or run (names or loaded BagLike objects). */
  readonly bags?: readonly (string | BagLike | BagToolInput)[];
  /** Additional bounds selected for the session or run (names or inline Bound objects). */
  readonly bounds?: readonly (Bound | string)[];
  /**
   * Already-resolved/pinned Bound for a running session (DESIGN §7.1.4).
   * When present, `resolve.tools` passes it directly to `Barry.tools` without
   * re-reading live `identity.bounds`.
   */
  readonly bound?: Bound | null;
  /** Target harness id (falls back to identity default harness or FALLBACK_HARNESS). */
  readonly harness?: string;
  /** Target harness mode (e.g., "hosted", "guest", "instrumented"). */
  readonly mode?: ModeId;
  /** Include base identity defaults (default true). */
  readonly defaults?: boolean;
  /** Include identity's own defaults (default true). */
  readonly identityDefaults?: boolean;
  /** Extra served tools (e.g., from remote MCP servers) to include in tool resolution. */
  readonly tools?: readonly BagToolInput[];
  /** Optional override for installed harness lookup in tests. */
  readonly harnesses?: readonly InstalledAdapter[];
  /** Optional override for base identity config in tests. */
  readonly base?: ResolvedIdentityConfig;
}

function installedHarnesses(override?: readonly InstalledAdapter[]): readonly InstalledAdapter[] {
  if (override) return override;
  try {
    return loadAdapters({ file: barryAdaptersPath() }).installed();
  } catch {
    return [];
  }
}

function assertNoLegacyBoundId(identity: IdentityRecord | null | undefined): void {
  if (
    identity?.metadata &&
    "bound_id" in identity.metadata &&
    (identity.metadata as Record<string, unknown>).bound_id != null
  ) {
    throw new BarryError(
      "conflict",
      `Identity ${identity.name} still carries bound_id`,
      "barry doctor --fix",
    );
  }
}

function resolvedConfig(identity: IdentityRecord | null | undefined): ResolvedIdentityConfig | undefined {
  if (!identity) return undefined;
  const raw = identity.metadata;
  if (Array.isArray(raw.bags) && raw.bags.some((item) => typeof item !== "string")) {
    const parsed = parseIdentityBags(raw.bags);
    return resolveIdentityConfig({
      ...identity,
      metadata: {
        ...raw,
        bags: parsed.bags,
        bag_configs: { ...parsed.bag_configs, ...(raw.bag_configs ?? {}) },
      },
    });
  }
  return resolveIdentityConfig(identity);
}

async function resolveNamedBound(
  name: string,
  identity: IdentityRecord | null | undefined,
  config: ResolvedIdentityConfig | undefined,
  base: ResolvedIdentityConfig | undefined,
  harnesses: readonly InstalledAdapter[],
  activeAdapter: InstalledAdapter | undefined,
  extraBags: readonly BagLike[],
): Promise<Bound> {
  for (const source of [config, base]) {
    for (const entry of source?.bounds ?? []) {
      if (entry.name === name && entry.bound) {
        return { ...entry.bound, name: entry.name };
      }
    }
  }

  for (const bag of extraBags) {
    const bagBounds = bag.bounds ?? bag.manifest?.bounds;
    if (bagBounds && !Array.isArray(bagBounds) && typeof bagBounds === "object") {
      for (const [key, def] of Object.entries(bagBounds)) {
        const qualified = key.includes(":") ? key : `${bag.name}:${key}`;
        if (key === name || qualified === name) {
          const unwrapped =
            def && typeof def === "object" && "bound" in def && def.bound
              ? { ...def.bound, ...(def.description ? { description: def.description } : {}) }
              : (def as Bound);
          return { ...unwrapped, name };
        }
      }
    }
  }

  const adaptersToCheck = activeAdapter ? [activeAdapter, ...harnesses] : harnesses;
  for (const record of adaptersToCheck) {
    const manifest = record.bag?.manifest;
    if (!manifest?.bounds) continue;
    const candidates = name.includes(":") ? [name, name.split(":").slice(1).join(":")] : [`${manifest.name}:${name}`, name];
    if (!name.includes(":") && record !== activeAdapter) continue;
    for (const candidate of candidates) {
      const def = manifest.bounds[candidate];
      if (def) {
        return {
          ...def.bound,
          name,
          ...(def.description ? { description: def.description } : {}),
        };
      }
    }
  }

  const found = await bounds.get(name, identity ?? undefined);
  if (found) return found;

  if (name.endsWith(":read") && name.length > ":read".length) {
    const bagName = name.slice(0, -":read".length);
    return { name, tools: { deny: [`${bagName}:write`] } };
  }
  if (name.endsWith("-readonly") && name.length > "-readonly".length) {
    const bagName = name.slice(0, -"-readonly".length);
    let bagExists = extraBags.some((b) => b.name === bagName);
    if (!bagExists) {
      try {
        bagExists = bagName in loadRegistry();
      } catch {
        bagExists = false;
      }
    }
    if (bagExists) {
      return { name, tools: { deny: [`${bagName}:write`] } };
    }
  }

  throw new Error(`unknown selected bound ${name}`);
}

function collectExtraBagLikes(items: readonly (string | BagLike | BagToolInput)[]): BagLike[] {
  const out: BagLike[] = [];
  for (const item of items) {
    if (typeof item === "object" && item !== null && "name" in item && typeof item.name === "string") {
      if ("tools" in item || "bounds" in item || "manifest" in item || "bags" in item || "implements" in item) {
        out.push(item as BagLike);
      }
    }
  }
  return out;
}

function buildHarnessTools(
  adapter: InstalledAdapter,
  resolvedBound: Bound,
  mode?: ModeId,
): Tool[] {
  const adapterTools = adapter.tools ?? [];
  if (!adapterTools.length) return [];
  const taken = new Set(nativeToolsTakenBack(resolvedBound, adapter));
  const selectedMode = mode ?? adapter.defaultMode;
  const nativeControl = selectedMode ? adapter.modes?.[selectedMode]?.native : undefined;
  const controllable = nativeControl
    ? (nativeControl.controllable ?? [])
    : adapterTools;
  const wanted = new Set(controllable.filter((tool) => !taken.has(tool)));
  const allowed = new Set(
    adapterTools.filter((tool) => wanted.has(tool) && controllable.includes(tool)),
  );
  for (const group of nativeControl?.inseparable ?? []) {
    if (!group.every((tool) => wanted.has(tool))) {
      for (const tool of group) allowed.delete(tool);
    }
  }
  const refused: Record<string, string> = {};
  for (const tool of adapterTools) {
    if (wanted.has(tool) && !allowed.has(tool)) {
      refused[tool] = `${adapter.id} cannot turn it on alone in ${selectedMode ?? "this mode"}; it stays off`;
    }
  }
  const uncontrolled = { ...nativeControl?.uncontrolled };

  const writeTools = new Set<string>();
  const manifest = adapter.bag?.manifest;
  for (const category of ["shell", "file-writes"] as const) {
    const catBound =
      manifest?.bounds?.[`${manifest.name}:no-${category}`]?.bound ??
      manifest?.bounds?.[`no-${category}`]?.bound;
    if (catBound) {
      for (const name of nativeToolDenials(catBound, adapter.id, adapterTools)) {
        writeTools.add(name);
      }
    }
  }

  const harnessTools: Tool[] = [];
  for (const name of adapterTools) {
    if (!allowed.has(name) && !refused[name] && !uncontrolled[name]) continue;
    harnessTools.push({
      id: `${adapter.id}:${name}`,
      name,
      namespace: adapter.id,
      bag: null,
      access: writeTools.has(name) ? "write" : "read",
      ...(refused[name] ? { unavailable: refused[name] } : {}),
      ...(uncontrolled[name] ? { uncontrolled: uncontrolled[name] } : {}),
    });
  }
  return harnessTools;
}

export const resolve = {
  /**
   * Resolve the `Bound` for `identity` plus `sel`.
   * When `sel.bound` is already a resolved/pinned `Bound`, returns it directly.
   */
  async bound(identity?: IdentityRecord | null, sel: ResolveSelection = {}): Promise<Bound> {
    assertNoLegacyBoundId(identity);
    if (sel.bound !== undefined && sel.bound !== null) {
      return Barry.Bound(sel.bound);
    }
    const base = sel.base ?? baseIdentityConfig();
    const config = resolvedConfig(identity);
    const harnesses = installedHarnesses(sel.harnesses);
    const harnessName =
      sel.harness ?? (config ? defaultHarness(config.adapters) ?? FALLBACK_HARNESS : undefined);
    const activeAdapter = harnessName ? findInstalled(harnesses, harnessName) : undefined;
    const extraBags = collectExtraBagLikes(sel.bags ?? []);

    const disabledBounds = new Set(
      sel.identityDefaults === false ? [] : optionalNames(config?.bounds ?? []),
    );
    const baseRequiredBoundNames =
      sel.defaults === false
        ? []
        : requiredNames(base?.bounds ?? []).filter((name) => !disabledBounds.has(name));
    const identityRequiredBoundNames =
      sel.identityDefaults === false ? [] : requiredNames(config?.bounds ?? []);

    const impliedBagBoundNames: string[] = [];
    for (const item of [
      ...(sel.defaults === false ? [] : (base?.bags ?? [])),
      ...(sel.identityDefaults === false ? [] : (config?.bags ?? [])),
      ...(sel.bags ?? []),
    ]) {
      if (typeof item === "string" && (item.endsWith(":read") || item.endsWith("-readonly"))) {
        impliedBagBoundNames.push(item);
      }
    }

    const toResolve: (Bound | string)[] = [
      ...baseRequiredBoundNames,
      ...identityRequiredBoundNames,
      ...(sel.identityDefaults !== false && config?.bound ? [config.bound] : []),
      ...impliedBagBoundNames,
      ...(sel.bounds ?? []),
    ];

    const resolvedList: Bound[] = [];
    for (const entry of toResolve) {
      if (typeof entry === "string") {
        resolvedList.push(
          await resolveNamedBound(
            entry,
            identity,
            config,
            base,
            harnesses,
            activeAdapter,
            extraBags,
          ),
        );
      } else if (entry && typeof entry === "object") {
        resolvedList.push(entry);
      }
    }

    return Barry.bound(undefined, resolvedList);
  },

  /**
   * Resolve the `Tool[]` for `identity` plus `sel`.
   * When `sel.bound` is already a resolved/pinned `Bound` (e.g. a running session's
   * `session.bound`), passes `sel.bound` directly to `Barry.tools` so live changes
   * to `identity.yaml` never mutate a running session (DESIGN §7.1.4).
   */
  async tools(identity?: IdentityRecord | null, sel: ResolveSelection = {}): Promise<Tool[]> {
    assertNoLegacyBoundId(identity);
    const base = sel.base ?? baseIdentityConfig();
    const config = resolvedConfig(identity);
    const harnesses = installedHarnesses(sel.harnesses);
    const harnessName =
      sel.harness ?? (config ? defaultHarness(config.adapters) ?? FALLBACK_HARNESS : undefined);
    const activeAdapter = harnessName ? findInstalled(harnesses, harnessName) : undefined;

    const disabledBags = new Set(
      sel.identityDefaults === false
        ? []
        : optionalIdentityBags(config?.bags ?? [], config?.bag_configs ?? {}),
    );
    const baseRequiredBags =
      sel.defaults === false || (identity == null && sel.bags !== undefined && sel.defaults !== true)
        ? []
        : requiredIdentityBags(base?.bags ?? [], base?.bag_configs ?? {}).filter(
            (name) => !disabledBags.has(name),
          );
    const identityRequiredBags =
      sel.identityDefaults === false
        ? []
        : requiredIdentityBags(config?.bags ?? [], config?.bag_configs ?? {});

    const stripReadSuffix = (name: string) =>
      name.endsWith(":read")
        ? name.slice(0, -":read".length)
        : name.endsWith("-readonly")
          ? name.slice(0, -"-readonly".length)
          : name;

    const requestedBagNames = new Set<string>(
      [...baseRequiredBags, ...identityRequiredBags].map(stripReadSuffix),
    );
    const directInputs: (BagLike | BagToolInput)[] = [];

    for (const item of sel.bags ?? []) {
      if (typeof item === "string") {
        const clean = stripReadSuffix(item);
        requestedBagNames.add(clean);
      } else if ("name" in item && typeof item.name === "string" && requestedBagNames.has(item.name)) {
        directInputs.push({ ...item, optional: false });
      } else {
        directInputs.push(item);
      }
    }

    let snapshotByName = new Map<string, BagLike>();
    if (requestedBagNames.size > 0) {
      try {
        let expanded = [...requestedBagNames];
        try {
          expanded = expandCompositionSync(expanded);
        } catch {
          // Fall back to direct bag names when snapshot is absent in unit tests
        }
        const loaded = await loadBags(expanded);
        snapshotByName = new Map(loaded.map((bag) => [bag.name, bag]));
      } catch {
        snapshotByName = new Map();
      }
    }

    const filterBagTools = (bag: BagLike): BagLike => {
      const overrides = config?.bag_configs?.[bag.name]?.tools;
      if (!overrides || !bag.tools) return bag;
      return {
        ...bag,
        tools: bag.tools.filter((t) => {
          const name = t.name ?? t.toolName;
          return !name || overrides[name] !== "disabled";
        }),
      };
    };

    const bagInputs: (BagLike | BagToolInput)[] = [];
    const addedBagNames = new Set<string>();
    for (const name of requestedBagNames) {
      const bag = snapshotByName.get(name);
      if (bag) {
        bagInputs.push(filterBagTools(bag));
        addedBagNames.add(name);
      }
    }
    const queue = [...addedBagNames];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const bag = snapshotByName.get(current) as
        | { manifest?: { bags?: readonly (string | { name: string; optional?: boolean })[] } | null }
        | undefined;
      for (const child of bag?.manifest?.bags ?? []) {
        const childName = typeof child === "string" ? child : child.optional ? null : child.name;
        if (childName && !addedBagNames.has(childName) && snapshotByName.has(childName)) {
          addedBagNames.add(childName);
          bagInputs.push(filterBagTools(snapshotByName.get(childName)!));
          queue.push(childName);
        }
      }
    }

    bagInputs.push(
      ...directInputs.map((item) =>
        "name" in item && typeof item.name === "string" && "tools" in item
          ? filterBagTools(item as BagLike)
          : item,
      ),
    );
    const collectedMeta =
      sel.tools !== undefined
        ? []
        : requestedBagNames.size > 0
          ? await collectToolDefinitions().catch(() => [])
          : [];
    const candidateTools: readonly BagToolInput[] = sel.tools
      ? [...collectedMeta, ...sel.tools]
      : collectedMeta;
    if (candidateTools.length) {
      const activeNamespaces = new Set<string>([...requestedBagNames, ...addedBagNames]);
      const existingQualified = new Set<string>();
      for (const entry of bagInputs) {
        if ("tools" in entry && Array.isArray(entry.tools)) {
          activeNamespaces.add(entry.name);
          for (const t of entry.tools) {
            const ns = t.namespace ?? entry.name;
            const name = t.name ?? t.toolName ?? "";
            activeNamespaces.add(ns);
            if (name) existingQualified.add(`${ns}:${name}`);
          }
          const servers = (entry as { mcpServers?: Record<string, unknown> }).mcpServers;
          for (const key of Object.keys(servers ?? {})) activeNamespaces.add(key);
          const manifestServers = (entry.manifest as { mcpServers?: Record<string, unknown> } | null | undefined)?.mcpServers;
          for (const key of Object.keys(manifestServers ?? {})) activeNamespaces.add(key);
        } else {
          const toolEntry = entry as BagToolInput;
          const ns = toolEntry.namespace ?? toolEntry.bag ?? "";
          const name = toolEntry.name ?? toolEntry.toolName ?? "";
          if (ns && name) existingQualified.add(`${ns}:${name}`);
        }
      }
      for (const t of candidateTools) {
        const ns = t.namespace ?? t.bag ?? "";
        const name = t.name ?? t.toolName ?? "";
        if (!ns || !name) continue;
        if (!activeNamespaces.has(ns)) continue;
        const qualified = `${ns}:${name}`;
        if (existingQualified.has(qualified)) continue;
        existingQualified.add(qualified);
        bagInputs.push(t);
      }
    }

    const resolvedBound =
      sel.bound !== undefined && sel.bound !== null
        ? Barry.Bound(sel.bound)
        : await resolve.bound(identity, sel);

    const resolvedTools = Barry.tools(
      {
        ...(identity ? { id: identity.id, name: identity.name } : {}),
        bags: [...requestedBagNames],
      },
      bagInputs,
      resolvedBound,
    );

    if (activeAdapter && sel.harness !== undefined) {
      const harnessTools = buildHarnessTools(activeAdapter, resolvedBound, sel.mode);
      return [...resolvedTools, ...harnessTools];
    }

    return resolvedTools;
  },

  /** For the session picker: every bag and bound this identity could select. */
  async selectable(
    identity?: IdentityRecord | null,
    options: { base?: ResolvedIdentityConfig } = {},
  ): Promise<{ bags: string[]; bounds: Bound[] }> {
    assertNoLegacyBoundId(identity);
    const base = options.base ?? baseIdentityConfig();
    const config = resolvedConfig(identity);
    const bags = Array.from(
      new Set([
        ...requiredIdentityBags(base?.bags ?? [], base?.bag_configs ?? {}),
        ...optionalIdentityBags(base?.bags ?? [], base?.bag_configs ?? {}),
        ...requiredIdentityBags(config?.bags ?? [], config?.bag_configs ?? {}),
        ...optionalIdentityBags(config?.bags ?? [], config?.bag_configs ?? {}),
      ]),
    );
    return {
      bags,
      bounds: await bounds.list(identity ?? undefined),
    };
  },
};
