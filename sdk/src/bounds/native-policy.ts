import { nativeToolDenials } from "./effective-bound.js";
import type { Bound, AgentTrait } from "./types.js";
import type { BagManifest } from "../bags/types.js";
import type { Mode, NativeControl } from "../adapters/harnesses/index.js";
import type { Tool } from "../barry/types.js";
import type { ModeId } from "../ids.js";

export interface NativeHarness {
  id: string;
  label?: string;
  nativeTools: readonly string[];
  defaultMode?: ModeId;
  modes?: Partial<Record<ModeId, Pick<Mode, "native"> | null>>;
  bag?: { manifest: Pick<BagManifest, "name" | "bounds"> };
}

export const NATIVE_CATEGORIES = ["shell", "file-reads", "file-writes", "network"] as const;

/** Native calls bypass Barry's guards, so a guarded restriction takes back the category. */
export function nativeToolsTakenBack(bound: Bound | null | undefined, harness: NativeHarness): string[] {
  const taken = new Set(nativeToolDenials(bound, harness.id, harness.nativeTools));
  if (!bound) return [...taken];
  const categories = new Set<typeof NATIVE_CATEGORIES[number]>();
  const take = (...names: typeof NATIVE_CATEGORIES[number][]) => names.forEach(name => categories.add(name));
  if (bound.bash?.deny?.length || bound.bash?.denyPrograms?.length) take("shell");
  if (bound.network?.actions?.length || bound.network?.domains?.length || bound.network?.allowDomains !== undefined || bound.network?.enforce === "sandbox") take("shell", "network");
  if (bound.files?.deny !== undefined || bound.files?.allowOnly !== undefined) take("shell", "file-reads", "file-writes");
  if (bound.deniedAccess?.includes("write")) take("shell", "file-writes");
  for (const name of bound.deniedTools ?? []) {
    const lower = name.toLowerCase();
    if (["bash"].includes(lower)) take("shell");
    if (["read", "glob", "grep"].includes(lower)) take("file-reads");
    if (["write", "edit"].includes(lower)) take("file-writes");
    if (lower === "filesystem") take("file-reads", "file-writes");
    if (["webfetch", "websearch"].includes(lower)) take("network");
    for (const tool of harness.nativeTools) if (tool.toLowerCase() === lower) taken.add(tool);
  }
  for (const category of categories) {
    const manifest = harness.bag?.manifest;
    const bound = manifest?.bounds?.[`${manifest.name}:no-${category}`]?.bound;
    for (const tool of bound ? nativeToolDenials(bound, harness.id, harness.nativeTools) : harness.nativeTools) taken.add(tool);
  }
  return harness.nativeTools.filter(tool => taken.has(tool));
}

function control(harness: NativeHarness, mode?: ModeId): NativeControl | undefined {
  const selected = mode ?? harness.defaultMode;
  return selected ? harness.modes?.[selected]?.native : undefined;
}

function status(wanted: ReadonlySet<string>, harness: NativeHarness, mode?: ModeId) {
  const native = control(harness, mode);
  const allowed = new Set(harness.nativeTools.filter(tool => wanted.has(tool) && native?.grantable.includes(tool)));
  for (const group of native?.inseparable ?? []) {
    if (!group.every(tool => wanted.has(tool))) for (const tool of group) allowed.delete(tool);
  }
  const refused: Record<string, string> = {};
  for (const tool of harness.nativeTools) {
    if (wanted.has(tool) && !allowed.has(tool)) refused[tool] = `${harness.id} cannot turn it on alone in ${mode ?? harness.defaultMode ?? "this mode"}; it stays off`;
  }
  return {
    allowed: harness.nativeTools.filter(tool => allowed.has(tool)),
    denied: harness.nativeTools.filter(tool => !allowed.has(tool)),
    refused,
    uncontrolled: { ...native?.uncontrolled },
  };
}

export function nativeToolStatus(traits: readonly AgentTrait[], bound: Bound | null | undefined, harness: NativeHarness, mode?: ModeId) {
  const taken = new Set(nativeToolsTakenBack(bound, harness));
  const wanted = new Set(traits.flatMap(trait => trait.nativeTools?.[harness.id] ?? []).filter(tool => !taken.has(tool)));
  return status(wanted, harness, mode);
}

export interface NativePolicy {
  allowed: string[];
  denied: string[];
  refused: Record<string, string>;
  uncontrolled: Record<string, string>;
  operatorOverride?: string;
  conflicts: Record<string, string>;
}

export function resolveNativePolicy(grants: { bound: Bound | null; tools: readonly Tool[] }, harness: NativeHarness, mode?: ModeId): NativePolicy {
  const taken = new Set(nativeToolsTakenBack(grants.bound, harness));
  const tools = grants.tools.filter(tool => tool.bag === null && tool.namespace === harness.id && !taken.has(tool.name));
  const result = status(new Set(tools.filter(tool => !tool.unavailable && !tool.uncontrolled).map(tool => tool.name)), harness, mode);
  for (const tool of tools) if (tool.unavailable) result.refused[tool.name] = tool.unavailable;
  return {
    ...result,
    ...(control(harness, mode)?.operatorOverride ? { operatorOverride: control(harness, mode)!.operatorOverride } : {}),
    conflicts: Object.fromEntries(Object.entries(result.uncontrolled).filter(([tool]) => taken.has(tool))),
  };
}

/** An adapter bag cannot grant or deny a native name its harness does not offer. */
export function validateNativeTools(manifest: Pick<BagManifest, "name" | "bounds" | "traits">, harness: Pick<NativeHarness, "id" | "nativeTools">): void {
  const validate = (name: string, tools: Record<string, string[]> | undefined) => {
    for (const [id, names] of Object.entries(tools ?? {})) {
      if (id !== harness.id) throw new Error(`${name} names harness ${id}, expected ${harness.id}`);
      nativeToolDenials({ nativeTools: tools }, id, harness.nativeTools);
      if (new Set(names).size !== names.length) throw new Error(`${name} lists a native tool twice`);
    }
  };
  for (const [name, definition] of Object.entries(manifest.bounds ?? {})) validate(`bound ${name}`, definition.bound.nativeTools);
  for (const [name, trait] of Object.entries(manifest.traits)) {
    validate(`trait ${name}`, trait.bound?.nativeTools);
    validate(`trait ${name}`, trait.nativeTools);
    for (const category of NATIVE_CATEGORIES) {
      if (name !== `${manifest.name}:native-${category}`) continue;
      const bound = manifest.bounds?.[`${manifest.name}:no-${category}`]?.bound;
      const denied = bound ? nativeToolDenials(bound, harness.id, harness.nativeTools) : [];
      const missing = (trait.nativeTools?.[harness.id] ?? []).filter(tool => !denied.includes(tool));
      if (missing.length) throw new Error(`${name} grants tools outside no-${category}: ${missing.join(", ")}`);
    }
  }
}
