import { z } from "zod";
import { HarnessIdSchema, MODE_IDS } from "../ids.js";

export const AdapterSettingsSchema = z.strictObject({
  default: z.boolean().optional(),
  model: z.string().min(1).optional(),
  account: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
  promptCacheTtl: z.enum(["5m", "1h"]).optional(),
  namespaceSplit:z.boolean().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  mode: z.enum(MODE_IDS).optional(),
});

export const IdentityAdaptersSchema = z.record(HarnessIdSchema, AdapterSettingsSchema).superRefine((adapters, context) => {
  if (Object.values(adapters).filter(settings => settings.default === true).length > 1) {
    context.addIssue({ code: "custom", message: "Only one adapter may be the default" });
  }
});

export type AdapterSettings = z.infer<typeof AdapterSettingsSchema>;
export type IdentityAdapters = Record<string, AdapterSettings>;
export const FALLBACK_HARNESS = "claude-code";

export function defaultHarness(adapters: Readonly<IdentityAdapters>): string | undefined {
  const entries = Object.entries(adapters);
  const defaults = entries.filter(([, settings]) => settings.default === true);
  if (defaults.length === 1) return defaults[0][0];
  if (!defaults.length && entries.length <= 1) return entries[0]?.[0];
  throw new Error("Identity adapters need one default. Run barry identity adapters set <harness> --default");
}

export function adapterSettings(adapters: Readonly<IdentityAdapters>, harness: { id: string; aliases?: readonly string[] }): AdapterSettings | undefined {
  for (const id of [harness.id, ...(harness.aliases ?? [])]) if (Object.hasOwn(adapters, id)) return adapters[id];
  return undefined;
}

function settingsOf(settings: AdapterSettings): AdapterSettings {
  const { default: chosen, ...fields } = settings;
  return { ...fields, ...(chosen === true ? { default: true } : {}) };
}

export function mergeAdapters(parent: Readonly<IdentityAdapters>, child: Readonly<IdentityAdapters>): IdentityAdapters {
  const merged = Object.fromEntries(Object.entries(parent).map(([id, settings]) => [id, settingsOf(settings)]));
  const childDefault = Object.values(child).some(settings => settings.default === true);
  if (childDefault) {
    for (const settings of Object.values(merged)) delete settings.default;
  } else if (Object.keys(parent).length === 1) {
    merged[Object.keys(parent)[0]].default = true;
  }
  for (const [id, settings] of Object.entries(child)) merged[id] = { ...merged[id], ...settingsOf(settings) };
  return merged;
}

/** Store only overrides, so editing a child never freezes its parent's settings. */
export function ownAdapters(parent: Readonly<IdentityAdapters>, intended: Readonly<IdentityAdapters>): IdentityAdapters {
  const own: IdentityAdapters = {};
  const intendedDefault = defaultHarness(intended);
  // An explicit child default can repair ambiguity inherited from an older file.
  const parentDefault = Object.values(parent).filter(entry => entry.default).length === 1 || Object.keys(parent).length <= 1 ? defaultHarness(parent) : undefined;
  for (const [id, settings] of Object.entries(intended)) {
    const fields: AdapterSettings = {};
    if(settings.namespaceSplit!==undefined && settings.namespaceSplit!==parent[id]?.namespaceSplit)fields.namespaceSplit=settings.namespaceSplit;
    if (settings.account !== undefined && settings.account !== parent[id]?.account) fields.account = settings.account;
    if (settings.model !== undefined && settings.model !== parent[id]?.model) fields.model = settings.model;
    if (settings.promptCacheTtl !== undefined && settings.promptCacheTtl !== parent[id]?.promptCacheTtl) fields.promptCacheTtl = settings.promptCacheTtl;
    if (settings.effort !== undefined && settings.effort !== parent[id]?.effort) fields.effort = settings.effort;
    if (settings.mode !== undefined && settings.mode !== parent[id]?.mode) fields.mode = settings.mode;
    if (id === intendedDefault && intendedDefault !== parentDefault) fields.default = true;
    if (!Object.hasOwn(parent, id) || Object.keys(fields).length) own[id] = fields;
  }
  return own;
}
