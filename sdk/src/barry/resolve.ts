import { BoundSchema, type Bound } from "../bounds/types.js";
import { mergeBounds } from "../bounds/merge-bounds.js";
import { applyBoundGuards, filterToolObjects, narrowJsonSchemaWithInputs } from "../bounds/tool-guards.js";
import { bagBinding } from "../bags/store.js";
import type { StoreBinding } from "../stores/bindings.js";
import type { StoreContext } from "../stores/context.js";
import type { Action, Bag, Instruction, Skill, Tool } from "./types.js";

export type BoundEntryLike =
  | Bound
  | string
  | { readonly name: string; readonly optional?: boolean; readonly bound?: Bound };

export interface IdentityLike {
  readonly id?: number;
  readonly name?: string;
  readonly node?: string;
  readonly storeContext?:
    | StoreContext
    | Record<string, unknown>
    | (() => StoreContext | Record<string, unknown> | Promise<StoreContext | Record<string, unknown>>);
  readonly bags?: readonly (
    | string
    | Bag
    | BagLike
    | { readonly name: string; readonly optional?: boolean }
  )[];
  readonly optionalBags?: readonly string[];
  readonly bounds?: readonly BoundEntryLike[];
  readonly bound?: Bound | null;
}

export interface BagToolInput extends Omit<Tool, "name" | "namespace" | "bag" | "access" | "description"> {
  readonly id?: string;
  readonly name?: string;
  readonly toolName?: string;
  readonly description?: string | null;
  readonly namespace?: string;
  readonly bag?: string | null;
  readonly access?: "read" | "write" | "readwrite";
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

export interface BagLike {
  readonly name: string;
  readonly description?: string | null;
  readonly optional?: boolean;
  readonly tools?: readonly BagToolInput[];
  readonly bounds?: Readonly<Record<string, Bound | { readonly description?: string; readonly bound: Bound }>> | readonly Bound[];
  readonly bags?:
    | Readonly<Record<string, { readonly optional?: boolean } | BagLike>>
    | readonly (string | { readonly name: string; readonly optional?: boolean } | BagLike)[];
  readonly requires?: Readonly<Record<string, unknown>> | readonly unknown[];
  readonly implements?: { readonly tools: readonly string[] };
  readonly skills?: readonly (Skill | string)[];
  readonly instructions?: readonly (Instruction | string)[];
  readonly actions?: readonly Action[];
  readonly manifest?: {
    readonly bounds?: Readonly<Record<string, Bound | { readonly description?: string; readonly bound: Bound }>>;
    readonly bags?:
      | Readonly<Record<string, { readonly optional?: boolean }>>
      | readonly (string | { readonly name: string; readonly optional?: boolean })[];
    readonly implements?: { readonly tools: readonly string[] };
  } | null;
}

function isToolInput(item: Bag | BagLike | BagToolInput): item is BagToolInput {
  if ("tools" in item && Array.isArray(item.tools)) return false;
  if ("manifest" in item && item.manifest !== undefined) return false;
  if ("handler" in item && typeof item.handler === "function") return true;
  if ("access" in item && (item.access === "read" || item.access === "write" || item.access === "readwrite")) return true;
  if ("namespace" in item && typeof item.namespace === "string") return true;
  return false;
}

function isFullBagLike(
  item: Bag | BagLike | { readonly name: string; readonly optional?: boolean },
): item is BagLike {
  return (
    "tools" in item ||
    "skills" in item ||
    "instructions" in item ||
    "actions" in item ||
    "bounds" in item ||
    "bags" in item ||
    "manifest" in item ||
    "implements" in item ||
    "requires" in item
  );
}

function isBoundEntryObject(
  entry: BoundEntryLike,
): entry is { readonly name: string; readonly optional?: boolean; readonly bound?: Bound } {
  if (typeof entry !== "object" || entry === null) return false;
  if (
    "tools" in entry ||
    "inputs" in entry ||
    "files" in entry ||
    "bash" in entry ||
    "network" in entry ||
    "nodes" in entry
  ) {
    return false;
  }
  return typeof (entry as { name?: unknown }).name === "string";
}

function unwrapBoundDef(
  raw: Bound | { readonly description?: string; readonly bound: Bound },
): Bound {
  if (
    raw &&
    typeof raw === "object" &&
    "bound" in raw &&
    raw.bound &&
    typeof raw.bound === "object" &&
    !("optional" in raw)
  ) {
    return {
      ...raw.bound,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    };
  }
  return raw as Bound;
}

function registerBagBounds(map: Map<string, Bound>, bag: BagLike): void {
  const bagBounds = bag.bounds ?? bag.manifest?.bounds;
  if (Array.isArray(bagBounds)) {
    for (const b of bagBounds) {
      if (b && typeof b === "object" && b.name) {
        const qualified = b.name.includes(":") ? b.name : `${bag.name}:${b.name}`;
        map.set(qualified, b);
        map.set(b.name, b);
      }
    }
  } else if (bagBounds && typeof bagBounds === "object") {
    for (const [key, b] of Object.entries(bagBounds)) {
      const unwrapped = unwrapBoundDef(b);
      const qualified = key.includes(":") ? key : `${bag.name}:${key}`;
      map.set(qualified, unwrapped);
      map.set(key, unwrapped);
    }
  }
}

function toNamedBoundsMap(
  availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  bags?: readonly (Bag | BagLike | BagToolInput)[],
  identity?: IdentityLike | null,
): Map<string, Bound> {
  const map = new Map<string, Bound>();
  if (availableBounds instanceof Map) {
    for (const [k, v] of availableBounds.entries()) {
      map.set(k, v);
    }
  } else if (availableBounds && typeof availableBounds === "object") {
    for (const [k, v] of Object.entries(availableBounds)) {
      map.set(k, v);
    }
  }

  if (identity?.bags) {
    for (const entry of identity.bags) {
      if (typeof entry === "object" && entry !== null && isFullBagLike(entry)) {
        registerBagBounds(map, entry);
      }
    }
  }

  if (bags) {
    for (const item of bags) {
      if (isToolInput(item)) continue;
      registerBagBounds(map, item as BagLike);
    }
  }

  if (identity?.bounds) {
    for (const entry of identity.bounds) {
      if (typeof entry === "object" && entry !== null) {
        if (isBoundEntryObject(entry) && entry.bound) {
          map.set(entry.name, entry.bound);
        } else if (!isBoundEntryObject(entry) && entry.name) {
          map.set(entry.name, entry);
        }
      }
    }
  }

  return map;
}

function resolveSingleBoundRef(
  item: Bound | string,
  namedBounds: ReadonlyMap<string, Bound>,
): Bound {
  if (typeof item === "string") {
    const found = namedBounds.get(item);
    if (found) {
      return BoundSchema.parse(found);
    }
    if (item.endsWith(":read") && item.length > ":read".length) {
      const bagName = item.slice(0, -":read".length);
      return BoundSchema.parse({
        name: item,
        tools: { deny: [`${bagName}:write`] },
      });
    }
    throw new Error(`unknown selected bound ${item}`);
  }
  return BoundSchema.parse(item);
}

/**
 * Fold an identity's non-optional bounds and the given bounds (including
 * `<bag>:read` shorthands) into a single resolved `Bound`.
 */
export function resolveBarryBound(
  identity: IdentityLike | null | undefined,
  bounds?: readonly (Bound | string)[],
  availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  bags?: readonly (Bag | BagLike | BagToolInput)[],
): Bound {
  const namedMap = toNamedBoundsMap(availableBounds, bags, identity);
  const toMerge: Bound[] = [];

  if (identity?.bounds) {
    for (const entry of identity.bounds) {
      if (typeof entry === "string") {
        if (namedMap.has(entry) || entry.endsWith(":read")) {
          toMerge.push(resolveSingleBoundRef(entry, namedMap));
        } else if (!identity.bound) {
          throw new Error(`unknown selected bound ${entry}`);
        }
      } else if (isBoundEntryObject(entry)) {
        if (entry.optional === true) continue;
        if (entry.bound) {
          toMerge.push(BoundSchema.parse(entry.bound));
        } else if (namedMap.has(entry.name) || entry.name.endsWith(":read")) {
          toMerge.push(resolveSingleBoundRef(entry.name, namedMap));
        } else if (!identity.bound) {
          throw new Error(`unknown selected bound ${entry.name}`);
        }
      } else if (entry && typeof entry === "object") {
        if ((entry as { optional?: boolean }).optional === true) continue;
        toMerge.push(BoundSchema.parse(entry));
      }
    }
  }

  if (toMerge.length === 0 && identity?.bound) {
    toMerge.push(BoundSchema.parse(identity.bound));
  }

  if (bounds) {
    for (const item of bounds) {
      toMerge.push(resolveSingleBoundRef(item, namedMap));
    }
  }

  return mergeBounds(...toMerge) ?? {};
}

function stripReadTwinSuffix(name: string): { cleanName: string; isReadTwin: boolean } {
  const isReadTwin = name.endsWith(":read") && name.length > ":read".length;
  return {
    cleanName: isReadTwin ? name.slice(0, -":read".length) : name,
    isReadTwin,
  };
}

function expandActiveBags(
  identity: IdentityLike | null | undefined,
  inputs: readonly (Bag | BagLike | BagToolInput)[],
): { activeBags: BagLike[]; directTools: BagToolInput[]; impliedBounds: string[] } {
  const activeBags: BagLike[] = [];
  const directTools: BagToolInput[] = [];
  const impliedBounds: string[] = [];
  const bagsByName = new Map<string, BagLike>();

  const indexBag = (bag: BagLike) => {
    const { cleanName } = stripReadTwinSuffix(bag.name);
    if (!bagsByName.has(cleanName) || isFullBagLike(bag)) {
      bagsByName.set(cleanName, cleanName === bag.name ? bag : { ...bag, name: cleanName });
    }
  };

  const isOptionalEntry = (
    item: Bag | BagLike | { readonly name: string; readonly optional?: boolean },
  ): boolean => (item as { readonly optional?: boolean }).optional === true;

  const optionalSet = new Set<string>(identity?.optionalBags ?? []);
  if (identity?.bags) {
    for (const entry of identity.bags) {
      if (typeof entry === "string") {
        if (entry.endsWith(":read")) {
          impliedBounds.push(entry);
        }
      } else if (entry && typeof entry === "object") {
        const { cleanName, isReadTwin } = stripReadTwinSuffix(entry.name);
        if (isReadTwin && !isOptionalEntry(entry)) {
          impliedBounds.push(entry.name);
        }
        if (isOptionalEntry(entry)) {
          optionalSet.add(cleanName);
        }
        if (isFullBagLike(entry)) {
          indexBag(entry);
        }
      }
    }
  }

  for (const item of inputs) {
    if (isToolInput(item)) {
      directTools.push(item);
    } else {
      indexBag(item as BagLike);
    }
  }

  const visited = new Set<string>();
  const visitBag = (bag: BagLike, explicit: boolean) => {
    const { cleanName, isReadTwin } = stripReadTwinSuffix(bag.name);
    if (isReadTwin) {
      impliedBounds.push(bag.name);
    }
    if (visited.has(cleanName)) return;
    if (!explicit && (bag.optional === true || optionalSet.has(cleanName))) return;
    visited.add(cleanName);
    const normalizedBag: BagLike = cleanName === bag.name ? bag : { ...bag, name: cleanName };
    const resolvedBag: BagLike = isFullBagLike(bag)
      ? normalizedBag
      : (bagsByName.get(cleanName) ?? normalizedBag);
    activeBags.push(resolvedBag);

    // Expand non-optional child `bags` (never `requires`)
    const children = resolvedBag.bags ?? resolvedBag.manifest?.bags;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === "string") {
          const { cleanName: childClean, isReadTwin: childRead } = stripReadTwinSuffix(child);
          if (childRead) impliedBounds.push(child);
          const childBag = bagsByName.get(childClean);
          if (childBag) visitBag(childBag, false);
        } else if (child && typeof child === "object" && !isOptionalEntry(child)) {
          const { cleanName: childClean, isReadTwin: childRead } = stripReadTwinSuffix(child.name);
          if (childRead) impliedBounds.push(child.name);
          const target = isFullBagLike(child) ? child : bagsByName.get(childClean);
          if (target) visitBag(target, false);
        }
      }
    } else if (children && typeof children === "object") {
      for (const [childName, childSpec] of Object.entries(children)) {
        if (childSpec && typeof childSpec === "object" && (childSpec as { optional?: boolean }).optional === true) {
          continue;
        }
        const { cleanName: childClean, isReadTwin: childRead } = stripReadTwinSuffix(childName);
        if (childRead) impliedBounds.push(childName);
        if (childSpec && typeof childSpec === "object" && "name" in childSpec && isFullBagLike(childSpec as BagLike)) {
          visitBag(childSpec as BagLike, false);
        } else {
          const childBag = bagsByName.get(childClean);
          if (childBag) visitBag(childBag, false);
        }
      }
    }
  };

  if (identity?.bags) {
    for (const entry of identity.bags) {
      if (typeof entry === "string") {
        const { cleanName } = stripReadTwinSuffix(entry);
        if (optionalSet.has(cleanName)) continue;
        const bag = bagsByName.get(cleanName);
        if (bag) visitBag({ ...bag, optional: false }, false);
      } else if (entry && typeof entry === "object") {
        const { cleanName } = stripReadTwinSuffix(entry.name);
        if (isOptionalEntry(entry) || optionalSet.has(cleanName)) continue;
        const bag = isFullBagLike(entry) ? entry : bagsByName.get(cleanName);
        if (bag) visitBag({ ...bag, optional: false }, false);
      }
    }
  }

  for (const item of inputs) {
    if (!isToolInput(item)) {
      const bag = item as BagLike;
      if (bag.optional === true) continue;
      visitBag(bag, true);
    }
  }

  return { activeBags, directTools, impliedBounds };
}

function classifyToolAccess(tool: BagToolInput): "read" | "write" {
  if (tool.access === "read" || tool.access === "write") {
    return tool.access;
  }
  if (tool.access === "readwrite") {
    return "write";
  }
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

const STORE_CONTEXT_KEY = Symbol.for("barry.store-context");

function getAmbientStoreContext(): StoreContext | undefined {
  const storage = (globalThis as Record<symbol, { getStore?: () => StoreContext | undefined }>)[
    STORE_CONTEXT_KEY
  ];
  return storage?.getStore?.();
}

function runWithAmbientStoreContext<T>(context: StoreContext, operation: () => T): T {
  const shared = globalThis as Record<
    symbol,
    { getStore?: () => StoreContext | undefined; run?: (ctx: StoreContext, op: () => T) => T }
  >;
  let storage = shared[STORE_CONTEXT_KEY];
  if (!storage) {
    const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process?.getBuiltinModule;
    const asyncHooks = getBuiltin?.("node:async_hooks") as
      | {
          AsyncLocalStorage?: new <S>() => {
            getStore: () => S | undefined;
            run: (ctx: S, op: () => T) => T;
          };
        }
      | undefined;
    if (asyncHooks?.AsyncLocalStorage) {
      storage = new asyncHooks.AsyncLocalStorage<StoreContext>();
      shared[STORE_CONTEXT_KEY] = storage;
    }
  }
  return storage?.run ? storage.run(context, operation) : operation();
}

function bindIdentityStoreContext<T extends Tool>(
  tool: T,
  identity: IdentityLike | null | undefined,
  bound: Bound,
): T {
  const identityName = identity?.name;
  const nodeId = identity?.node;
  const storeContextProvider = identity?.storeContext;
  const hasNodesBound = Boolean(
    bound.nodes?.deny?.length ||
      bound.nodes?.allow !== undefined ||
      bound.nodes?.allowClauses?.length,
  );
  if (!tool.handler || (!identityName && !nodeId && !storeContextProvider && !hasNodesBound)) {
    return tool;
  }
  const prev = tool.handler;
  return {
    ...tool,
    handler: async (params, context) => {
      const current = getAmbientStoreContext() ?? {};
      const effectiveNode =
        nodeId ?? (typeof current.node === "string" ? current.node : undefined);
      if (effectiveNode && hasNodesBound) {
        if (
          bound.nodes?.deny?.includes(effectiveNode) ||
          (bound.nodes?.allow !== undefined && !bound.nodes.allow.includes(effectiveNode)) ||
          (bound.nodes?.allowClauses?.length &&
            !bound.nodes.allowClauses.every((clause) => clause.includes(effectiveNode)))
        ) {
          throw new Error(`node access denied: ${effectiveNode}`);
        }
      }
      if (storeContextProvider) {
        const extra =
          typeof storeContextProvider === "function"
            ? await storeContextProvider()
            : storeContextProvider;
        return runWithAmbientStoreContext(
          {
            ...current,
            ...(identityName ? { identity: identityName } : {}),
            ...(nodeId ? { node: nodeId } : {}),
            ...(extra as StoreContext),
          },
          () => prev(params, context),
        );
      }
      if (identityName && current.identity !== identityName) {
        return runWithAmbientStoreContext(
          {
            ...current,
            identity: identityName,
            ...(nodeId ? { node: nodeId } : {}),
          },
          () => prev(params, context),
        );
      }
      return prev(params, context);
    },
  };
}

/**
 * Deterministic capability & access-control pipeline (`Barry.tools`):
 * 1. Expands active bags (`bags:` yes, `requires:` no).
 * 2. Collects tools, classifies remote access (`readOnlyHint === true ? "read" : "write"`),
 *    and applies `implements: { tools: [...] }` replacements in-place.
 * 3. Uses a single pinned `Bound` directly (without re-reading `identity.bounds`)
 *    when `bounds` is a non-array `Bound` object, or resolves `Barry.bound(identity, bounds)`.
 * 4. Filters tools against `bound.tools` and `bound.network`.
 * 5. Narrows JSON schemas for literal `bound.inputs` and wraps each `handler` with
 *    runtime guards (`inputs`, `files` + built-in config write protection, `bash`, `network`)
 *    and identity store context binding.
 */
export function resolveBarryTools<T extends BagToolInput = Tool>(
  identity: IdentityLike | null | undefined,
  bags: readonly (Bag | BagLike | T)[],
  bounds?: Bound | readonly (Bound | string)[],
  availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
): (Tool & T)[] {
  const { activeBags, directTools, impliedBounds } = expandActiveBags(identity, bags);

  const collected: Tool[] = [];
  const bagToolsMap = new Map<string, Tool[]>();

  for (const bag of activeBags) {
    const toolsForBag: Tool[] = [];
    for (const rawTool of bag.tools ?? []) {
      const rawName = rawTool.name ?? rawTool.toolName ?? "";
      const colonIdx = rawName.indexOf(":");
      const namespace =
        rawTool.namespace ?? (colonIdx !== -1 ? rawName.slice(0, colonIdx) : bag.name);
      const name = colonIdx !== -1 ? rawName.slice(colonIdx + 1) : rawName;
      const id = rawTool.id ?? `${namespace}:${name}`;
      const normalized: Tool = {
        ...rawTool,
        description: rawTool.description ?? undefined,
        id,
        name,
        namespace,
        bag: rawTool.bag !== undefined ? rawTool.bag : bag.name,
        access: classifyToolAccess(rawTool),
      };
      toolsForBag.push(normalized);
      collected.push(normalized);
    }
    bagToolsMap.set(bag.name, toolsForBag);
  }

  for (const rawTool of directTools) {
    const rawName = rawTool.name ?? rawTool.toolName ?? "";
    const colonIdx = rawName.indexOf(":");
    const namespace =
      rawTool.namespace ??
      (colonIdx !== -1 ? rawName.slice(0, colonIdx) : (rawTool.bag ?? "default"));
    const name = colonIdx !== -1 ? rawName.slice(colonIdx + 1) : rawName;
    const id = rawTool.id ?? `${namespace}:${name}`;
    collected.push({
      ...rawTool,
      description: rawTool.description ?? undefined,
      id,
      name,
      namespace,
      bag: rawTool.bag ?? namespace,
      access: classifyToolAccess(rawTool),
    });
  }

  // Apply `implements: { tools: [...] }` replacements in-place
  const implementedBy = new Map<string, string>();
  for (const bag of activeBags) {
    const implTools = bag.implements?.tools ?? bag.manifest?.implements?.tools;
    if (!implTools?.length) continue;

    const ownTools = bagToolsMap.get(bag.name) ?? [];
    for (const targetQualified of implTools) {
      const existingImpl = implementedBy.get(targetQualified);
      if (existingImpl && existingImpl !== bag.name) {
        throw new Error(
          `Multiple active bags implement tool "${targetQualified}": "${existingImpl}" and "${bag.name}"`,
        );
      }
      implementedBy.set(targetQualified, bag.name);

      const [targetNs, targetName] = targetQualified.split(":");
      const replacementSource = ownTools.find(
        (t) =>
          t.id === targetQualified ||
          t.name === targetName ||
          t.name === targetQualified,
      );
      if (!replacementSource) continue;

      // Remove standalone copy under implementing bag's own namespace if distinct
      if (replacementSource.id !== targetQualified) {
        const ownIdx = collected.indexOf(replacementSource);
        if (ownIdx !== -1) {
          collected.splice(ownIdx, 1);
        }
      }

      const targetIdx = collected.findIndex(
        (t) =>
          (t.id ?? `${t.namespace}:${t.name}`) === targetQualified ||
          (t.namespace === targetNs && t.name === targetName),
      );
      const existingTarget = targetIdx !== -1 ? collected[targetIdx] : undefined;
      const replacedTool: Tool = {
        ...(existingTarget ?? {}),
        ...replacementSource,
        id: targetQualified,
        namespace: targetNs,
        name: targetName,
        bag: bag.name,
        access: replacementSource.access ?? existingTarget?.access ?? "read",
      };

      if (targetIdx !== -1) {
        collected[targetIdx] = replacedTool;
      } else {
        collected.push(replacedTool);
      }
    }
  }

  // Resolve or use pinned Bound:
  // When `bounds` is a single resolved Bound object (not an array), use it directly
  // WITHOUT re-merging `identity.bounds`.
  const isPinnedBound =
    bounds !== undefined && bounds !== null && !Array.isArray(bounds);
  const resolvedBound: Bound = isPinnedBound
    ? (mergeBounds(
        BoundSchema.parse(bounds),
        ...impliedBounds.map((b) => resolveSingleBoundRef(b, new Map())),
      ) ?? BoundSchema.parse(bounds))
    : resolveBarryBound(
        identity,
        [...impliedBounds, ...((bounds as readonly (Bound | string)[] | undefined) ?? [])],
        availableBounds,
        bags,
      );

  const filtered = filterToolObjects(collected, resolvedBound);

  return filtered.map((tool) => {
    const qualifiedId = tool.id ?? `${tool.namespace}:${tool.name}`;
    const inputRules =
      resolvedBound.inputs?.[qualifiedId] ?? resolvedBound.inputs?.[tool.name];
    let current: Tool = tool;
    if (inputRules && current.input && typeof current.input === "object") {
      current = {
        ...current,
        input: narrowJsonSchemaWithInputs(current.input, inputRules),
      };
    }
    if (typeof current.handler === "function") {
      const [guarded] = applyBoundGuards(
        [
          {
            ...current,
            id: qualifiedId,
            handler: current.handler,
          },
        ],
        resolvedBound,
        { enforceConfigProtection: true },
      );
      current = bindIdentityStoreContext(guarded, identity, resolvedBound);
    }
    return current as Tool & T;
  });
}

export function resolveBarrySkills(
  identity: IdentityLike | null | undefined,
  bags: readonly (Bag | BagLike)[],
): Skill[] {
  const { activeBags } = expandActiveBags(identity, bags);
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const bag of activeBags) {
    for (const s of bag.skills ?? []) {
      const name = typeof s === "string" ? s : s.name;
      const qualified = name.includes(":") ? name : `${bag.name}:${name}`;
      if (!seen.has(qualified)) {
        seen.add(qualified);
        skills.push(typeof s === "string" ? { name: qualified } : { ...s, name: qualified });
      }
    }
  }
  return skills;
}

export function resolveBarryInstructions(
  identity: IdentityLike | null | undefined,
  bags: readonly (Bag | BagLike)[],
): Instruction[] {
  const { activeBags } = expandActiveBags(identity, bags);
  const instructions: Instruction[] = [];
  const seen = new Set<string>();
  for (const bag of activeBags) {
    for (const inst of bag.instructions ?? []) {
      const name = typeof inst === "string" ? inst : inst.name;
      const qualified = name.includes(":") ? name : `${bag.name}:${name}`;
      if (!seen.has(qualified)) {
        seen.add(qualified);
        instructions.push(
          typeof inst === "string" ? { name: qualified } : { ...inst, name: qualified },
        );
      }
    }
  }
  return instructions;
}

export function resolveBarryActions(
  identity: IdentityLike | null | undefined,
  bags: readonly (Bag | BagLike)[],
): Action[] {
  const { activeBags } = expandActiveBags(identity, bags);
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const bag of activeBags) {
    for (const act of bag.actions ?? []) {
      const key = act.qualifiedName || `${bag.name}:${act.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        actions.push(act);
      }
    }
  }
  return actions;
}

export interface BoundConstructor {
  (bound: Bound): Bound;
  merge: typeof mergeBounds;
}

export const defineBound: BoundConstructor = Object.assign(
  (bound: Bound): Bound => BoundSchema.parse(bound),
  { merge: mergeBounds },
);

export function defineStore(bagOrName: string, storeName?: string): StoreBinding {
  return bagBinding(bagOrName).store(storeName);
}
