import { nativeToolDenials } from "./resolve-bound.js";
import type { Bound } from "./types.js";
import type { BagManifest } from "../bags/types.js";
import type { Mode } from "../adapters/harnesses/index.js";
import type { Tool } from "../barry/types.js";
import type { ModeId } from "../ids.js";

export interface NativeHarness {
  id: string;
  label?: string;
  tools?: readonly string[];
  defaultMode?: ModeId;
  modes?: Partial<Record<ModeId, Pick<Mode, "native"> | null>>;
  bag?: { manifest: Pick<BagManifest, "name" | "bounds"> };
}

function getHarnessInventory(harness: Pick<NativeHarness, "tools">): readonly string[] {
  return harness.tools ?? [];
}

export const NATIVE_CATEGORIES = ["shell", "file-reads", "file-writes", "network"] as const;

/** Native calls bypass Barry's guards, so a guarded restriction takes back the category. */
export function nativeToolsTakenBack(bound: Bound | null | undefined, harness: NativeHarness): string[] {
  const inventory = getHarnessInventory(harness);
  const taken = new Set(nativeToolDenials(bound, harness.id, inventory));
  if (!bound) return [...taken];
  const categories = new Set<(typeof NATIVE_CATEGORIES)[number]>();
  const take = (...names: (typeof NATIVE_CATEGORIES)[number][]) =>
    names.forEach((name) => categories.add(name));

  if (
    bound.bash?.deny?.length ||
    bound.bash?.allow !== undefined ||
    bound.bash?.allowClauses?.length
  ) {
    take("shell");
  }
  if (
    bound.network?.deny?.length ||
    bound.network?.allow !== undefined ||
    bound.network?.allowClauses?.length ||
    bound.network?.enforce === "sandbox"
  ) {
    take("shell", "network");
  }
  if (
    bound.files?.deny !== undefined ||
    bound.files?.allow !== undefined ||
    bound.files?.allowClauses !== undefined
  ) {
    take("shell", "file-reads", "file-writes");
  }
  if (bound.inputs && Object.keys(bound.inputs).length > 0) {
    take("shell");
  }
  const allowClauses = bound.tools?.allowClauses?.length
    ? bound.tools.allowClauses
    : bound.tools?.allow !== undefined
      ? [bound.tools.allow]
      : undefined;
  const allowOmitsWrite =
    allowClauses !== undefined &&
    allowClauses.some(
      (clause) =>
        !clause.some(
          (pattern) =>
            pattern === "*" ||
            pattern === "*:*" ||
            pattern === "*:write" ||
            pattern === `${harness.id}:*` ||
            pattern === `${harness.id}:write`,
        ),
    );

  if (
    bound.tools?.deny?.includes("*:write") ||
    (bound.tools?.deny?.includes(`${harness.id}:write`) && !inventory.includes("write")) ||
    allowOmitsWrite
  ) {
    take("shell", "file-writes");
  }

  for (const name of bound.tools?.deny ?? []) {
    if (name.includes(":") && !name.startsWith("*:")) continue;
    const bare = name.startsWith("*:") ? name.slice(2) : name;
    const lower = bare.toLowerCase();
    if (["bash"].includes(lower)) take("shell");
    if (["read", "glob", "grep"].includes(lower)) take("file-reads");
    if (["write", "edit"].includes(lower)) take("file-writes");
    if (lower === "filesystem") take("file-reads", "file-writes");
    if (["webfetch", "websearch"].includes(lower)) take("network");
    for (const tool of inventory) {
      if (tool.toLowerCase() === lower) taken.add(tool);
    }
  }

  for (const category of categories) {
    const manifest = harness.bag?.manifest;
    const categoryKey = category === "shell" ? ["no-bash", "no-shell"] : [`no-${category}`];
    const categoryBound = categoryKey
      .map(
        (key) =>
          manifest?.bounds?.[`${manifest.name}:${key}`]?.bound ?? manifest?.bounds?.[key]?.bound,
      )
      .find((b) => b !== undefined);
    for (const tool of categoryBound
      ? nativeToolDenials(categoryBound, harness.id, inventory)
      : inventory) {
      taken.add(tool);
    }
  }
  return inventory.filter((tool) => taken.has(tool));
}

function control(harness: NativeHarness, mode?: ModeId): Mode["native"] {
  const selected = mode ?? harness.defaultMode;
  return selected ? harness.modes?.[selected]?.native : undefined;
}

function getControllableList(native: Mode["native"]): readonly string[] {
  const withControllable = native as
    | { controllable?: readonly string[]; grantable?: readonly string[] }
    | undefined;
  return withControllable?.controllable ?? withControllable?.grantable ?? [];
}

function status(wanted: ReadonlySet<string>, harness: NativeHarness, mode?: ModeId) {
  const inventory = getHarnessInventory(harness);
  const native = control(harness, mode);
  const controllable = getControllableList(native);
  const allowed = new Set(
    inventory.filter((tool) => wanted.has(tool) && controllable.includes(tool)),
  );
  for (const group of native?.inseparable ?? []) {
    if (!group.every((tool) => wanted.has(tool))) {
      for (const tool of group) allowed.delete(tool);
    }
  }
  const refused: Record<string, string> = {};
  for (const tool of inventory) {
    if (wanted.has(tool) && !allowed.has(tool)) {
      refused[tool] = `${harness.id} cannot turn it on alone in ${mode ?? harness.defaultMode ?? "this mode"}; it stays off`;
    }
  }
  return {
    allowed: inventory.filter((tool) => allowed.has(tool)),
    denied: inventory.filter((tool) => !allowed.has(tool)),
    refused,
    uncontrolled: { ...native?.uncontrolled },
  };
}

export interface NativeToolResolution {
  allowed: string[];
  denied: string[];
  refused: Record<string, string>;
  uncontrolled: Record<string, string>;
  operatorOverride?: string;
  conflicts: Record<string, string>;
}

export function resolveNativeTools(
  resolved: { bound: Bound | null; tools: readonly Tool[] },
  harness: NativeHarness | null | undefined,
  mode?: ModeId,
): NativeToolResolution;
export function resolveNativeTools(
  bound: Bound | null | undefined,
  tools: readonly Tool[],
  harness: NativeHarness | null | undefined,
  mode?: ModeId,
): NativeToolResolution;
export function resolveNativeTools(
  resolvedOrBound: { bound: Bound | null; tools: readonly Tool[] } | Bound | null | undefined,
  harnessOrTools: NativeHarness | readonly Tool[] | null | undefined,
  modeOrHarness?: ModeId | NativeHarness | null,
  maybeMode?: ModeId,
): NativeToolResolution {
  let bound: Bound | null;
  let candidateTools: readonly Tool[];
  let harness: NativeHarness | null | undefined;
  let mode: ModeId | undefined;
  const isThreeArgObject =
    resolvedOrBound !== null &&
    resolvedOrBound !== undefined &&
    typeof resolvedOrBound === "object" &&
    "bound" in resolvedOrBound &&
    "tools" in resolvedOrBound &&
    Array.isArray((resolvedOrBound as { tools?: unknown }).tools);

  if (isThreeArgObject) {
    const obj = resolvedOrBound as { bound: Bound | null; tools: readonly Tool[] };
    bound = obj.bound;
    candidateTools = obj.tools;
    harness = harnessOrTools as NativeHarness | null | undefined;
    mode = modeOrHarness as ModeId | undefined;
  } else {
    bound = (resolvedOrBound ?? null) as Bound | null;
    const passedTools = Array.isArray(harnessOrTools) ? (harnessOrTools as readonly Tool[]) : [];
    harness = modeOrHarness as NativeHarness | null | undefined;
    mode = maybeMode;
    if (
      harness &&
      !passedTools.some((tool) => tool.bag === null && tool.namespace === harness!.id)
    ) {
      const uncontrolled = control(harness, mode)?.uncontrolled ?? {};
      const synthesized: Tool[] = getHarnessInventory(harness).map((name) => ({
        name,
        namespace: harness!.id,
        bag: null,
        access: "read",
        ...(uncontrolled[name] ? { uncontrolled: uncontrolled[name] } : {}),
      }));
      candidateTools = [...passedTools, ...synthesized];
    } else {
      candidateTools = passedTools;
    }
  }

  if (!harness) {
    return { allowed: [], denied: [], refused: {}, uncontrolled: {}, conflicts: {} };
  }

  const taken = new Set(nativeToolsTakenBack(bound, harness));
  const tools = candidateTools.filter(
    (tool) => tool.bag === null && tool.namespace === harness.id && !taken.has(tool.name),
  );
  const result = status(
    new Set(
      tools.filter((tool) => !tool.unavailable && !tool.uncontrolled).map((tool) => tool.name),
    ),
    harness,
    mode,
  );
  for (const tool of tools) {
    if (tool.unavailable) result.refused[tool.name] = tool.unavailable;
  }
  return {
    ...result,
    ...(control(harness, mode)?.operatorOverride
      ? { operatorOverride: control(harness, mode)!.operatorOverride }
      : {}),
    conflicts: Object.fromEntries(
      Object.entries(result.uncontrolled).filter(([tool]) => taken.has(tool)),
    ),
  };
}

/** An adapter bag cannot deny a native name its harness does not offer. */
export function validateNativeTools(
  manifest: Pick<BagManifest, "name" | "bounds">,
  harness: Pick<NativeHarness, "id" | "tools">,
): void {
  const inventory = getHarnessInventory(harness);
  for (const [, definition] of Object.entries(manifest.bounds ?? {})) {
    if (definition.bound.tools?.deny?.length) {
      nativeToolDenials(definition.bound, harness.id, inventory);
    }
  }
}

