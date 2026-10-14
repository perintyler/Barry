import { FALLBACK_HARNESS, type IdentityAdapters } from "./adapters.js";

export const RETIRED_IDENTITY_KEYS = ["default_harness", "default_coding_agent", "default_model", "default_model_provider", "allow_native_tools"] as const;
export type RetiredIdentityKeys = Partial<Record<typeof RETIRED_IDENTITY_KEYS[number], unknown>>;

export function adaptersFromRetired(retired: RetiredIdentityKeys, lookups: {
  harness(name: string): string | undefined;
  isVendor(name: string): boolean;
  runsOn: string;
}): { adapters: IdentityAdapters; notes: string[]; problems: string[] } {
  const adapters: IdentityAdapters = {};
  const notes: string[] = [];
  const problems: string[] = [];
  const named = retired.default_harness ?? retired.default_coding_agent;
  const model = retired.default_model;
  const provider = retired.default_model_provider;
  for (const [key, value] of Object.entries(retired)) {
    if (key !== "allow_native_tools" && (typeof value !== "string" || !value.length)) problems.push(`${key} needs a non-empty string; edit it by hand`);
  }
  const harness = typeof named === "string" ? lookups.harness(named) : undefined;
  const vendor = typeof named === "string" && !harness && lookups.isVendor(named) ? named : undefined;
  const id = harness ?? (vendor ? FALLBACK_HARNESS : typeof named === "string" ? named : lookups.runsOn);
  if (named !== undefined) adapters[id] = { default: true };
  if (typeof model === "string") {
    const prefix = typeof provider === "string" ? provider : vendor;
    adapters[id] = { ...adapters[id], model: prefix && !model.startsWith(`${prefix}/`) ? `${prefix}/${model}` : model };
  } else if (provider !== undefined || vendor) {
    problems.push("A model provider without default_model cannot be converted; set a model by hand");
  }
  if (Object.hasOwn(retired, "allow_native_tools")) notes.push("allow_native_tools had no effect and was removed; native tools are granted by the harness’s native-* traits");
  return { adapters, notes, problems };
}
