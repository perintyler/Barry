import { extensionName, parentOf } from "../bags/extensions.js";
import { z } from "zod";
import { ToolVisibilitySchema } from "../tools/visibility.js";
import { mergeStoreOptions, StoreOptionsSchema, type StoreOptions } from "../stores/options.js";

export type ToolVisibility = "enabled" | "deferred" | "disabled";
export interface IdentityBagConfiguration {
  stores?: Record<string, StoreOptions>;
  tools?: Record<string, ToolVisibility>;
}
export type IdentityBags = Array<string | Record<string, unknown>> | Record<string, unknown>;

const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
/** A plain bag name or a registered extension name (<parent>/<name>). */
export const BagNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i);
const visibilitySchema = z.enum(["enabled", "deferred", "disabled"]);
const toolsSchema = z.union([z.record(z.string().min(1), visibilitySchema), ToolVisibilitySchema]);
/** One bag's configuration in an identity: its stores and its tools' visibility. */
export const IdentityBagConfigurationSchema = z.strictObject({
  store: StoreOptionsSchema.optional(),
  stores: z.record(nameSchema, StoreOptionsSchema).optional(),
  tools: toolsSchema.optional(),
}).superRefine((value, context) => {
  if (value.store && value.stores) context.addIssue({ code: "custom", message: "declare either store or stores, never both" });
}).transform((value): IdentityBagConfiguration => ({
  ...(value.store ? { stores: { default: value.store } } : value.stores ? { stores: value.stores } : {}),
  ...(value.tools ? { tools: value.tools } : {}),
}));

export function mergeBagConfiguration(parent: IdentityBagConfiguration = {}, child: IdentityBagConfiguration = {}): IdentityBagConfiguration {
  const stores: Record<string, StoreOptions> = {};
  for (const name of new Set([...Object.keys(parent.stores ?? {}), ...Object.keys(child.stores ?? {})]))
    stores[name] = mergeStoreOptions(parent.stores?.[name], child.stores?.[name]);
  const tools = { ...parent.tools, ...child.tools };
  return { ...(Object.keys(stores).length ? { stores } : {}), ...(Object.keys(tools).length ? { tools } : {}) };
}

export function parseIdentityBags(raw: unknown): { bags: string[]; bag_configs: Record<string, IdentityBagConfiguration> } {
  if (raw === undefined) return { bags: [], bag_configs: {} };
  if (!raw || typeof raw !== "object") throw new TypeError("identity bags must be a list or mapping");
  const bags = new Set<string>();
  const bag_configs: Record<string, IdentityBagConfiguration> = {};
  const entries = Array.isArray(raw) ? raw : [raw];
  const plainName = (name: string): string => {
    const parent = parentOf(name);
    if (parent) throw new Error(`list ${name} under its parent: - ${parent}: { extensions: [${name.slice(parent.length + 1)}] }`);
    return nameSchema.parse(name);
  };
  for (const entry of entries) {
    if (typeof entry === "string") { bags.add(plainName(entry)); continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("identity bag entries must be names or mappings");
    if (Array.isArray(raw) && Object.keys(entry).length !== 1) throw new TypeError("each identity bag override must name exactly one bag");
    for (const [name, value] of Object.entries(entry)) {
      plainName(name);
      bags.add(name);
      const entryValue = z.strictObject({ extensions: z.array(nameSchema).optional() }).passthrough().parse(value ?? {});
      const { extensions, ...settings } = entryValue;
      const configuration = IdentityBagConfigurationSchema.parse(settings);
      for (const extension of extensions ?? []) bags.add(extensionName(name, extension));
      bag_configs[name] = mergeBagConfiguration(Object.hasOwn(bag_configs, name) ? bag_configs[name] : undefined, configuration);
    }
  }
  const ordered = [...bags].filter((bag) => parentOf(bag) === null).flatMap((parent) => [parent, ...[...bags].filter((bag) => parentOf(bag) === parent)]);
  return { bags: ordered, bag_configs };
}

export function serializeIdentityBags(bags: readonly string[], configurations: Readonly<Record<string, IdentityBagConfiguration>> = {}): IdentityBags {
  const names = [...new Set(bags.map((bag) => BagNameSchema.parse(bag)))];
  for (const name of Object.keys(configurations)) {
    const parent = parentOf(name);
    if (parent) throw new Error(`extension ${name} takes no configuration; configure parent ${parent}`);
    if (!names.includes(name)) throw new Error(`configuration names unselected bag ${name}`);
  }
  const parents = new Set(names.map((name) => parentOf(name) ?? name));
  return [...parents].map((name) => {
    const extensions = names.filter((bag) => parentOf(bag) === name).map((bag) => bag.slice(name.length + 1));
    const configuration = configurations[name] ?? {};
    if (!extensions.length && !Object.keys(configuration).length) return name;
    const stores = configuration.stores;
    const singular = stores && Object.keys(stores).length === 1 && stores.default;
    return { [name]: {
      ...(singular ? { store: stores.default } : stores ? { stores } : {}),
      ...(configuration.tools ? { tools: Object.entries(configuration.tools).map(([tool, visibility]) => ({ [tool]: visibility })) } : {}),
      ...(extensions.length ? { extensions } : {}),
    } };
  });
}
