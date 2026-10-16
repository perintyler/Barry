import { z } from "zod";
import { ToolVisibilitySchema } from "../tools/visibility.js";
import { mergeStoreOptions, StoreOptionsSchema, type StoreOptions } from "../stores/options.js";

export type ToolVisibility = "enabled" | "deferred" | "disabled";
export interface IdentityBagConfiguration {
  optional?: boolean;
  stores?: Record<string, StoreOptions>;
  tools?: Record<string, ToolVisibility>;
}
export type IdentityBags = Array<string | Record<string, unknown>> | Record<string, unknown>;

const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
/** A plain bag name. */
export const BagNameSchema = nameSchema;
const visibilitySchema = z.enum(["enabled", "deferred", "disabled"]);
const toolsSchema = z.union([z.record(z.string().min(1), visibilitySchema), ToolVisibilitySchema]);
/** One bag's configuration in an identity: whether it is optional, its stores, and its tools' visibility. */
export const IdentityBagConfigurationSchema = z.strictObject({
  optional: z.boolean().optional(),
  store: StoreOptionsSchema.optional(),
  stores: z.record(nameSchema, StoreOptionsSchema).optional(),
  tools: toolsSchema.optional(),
}).superRefine((value, context) => {
  if (value.store && value.stores) context.addIssue({ code: "custom", message: "declare either store or stores, never both" });
}).transform((value): IdentityBagConfiguration => ({
  ...(value.optional !== undefined ? { optional: value.optional } : {}),
  ...(value.store ? { stores: { default: value.store } } : value.stores ? { stores: value.stores } : {}),
  ...(value.tools ? { tools: value.tools } : {}),
}));

export function mergeBagConfiguration(parent: IdentityBagConfiguration = {}, child: IdentityBagConfiguration = {}): IdentityBagConfiguration {
  const stores: Record<string, StoreOptions> = {};
  for (const name of new Set([...Object.keys(parent.stores ?? {}), ...Object.keys(child.stores ?? {})]))
    stores[name] = mergeStoreOptions(parent.stores?.[name], child.stores?.[name]);
  const tools = { ...parent.tools, ...child.tools };
  const optional = child.optional !== undefined ? child.optional : parent.optional;
  return {
    ...(optional ? { optional: true } : {}),
    ...(Object.keys(stores).length ? { stores } : {}),
    ...(Object.keys(tools).length ? { tools } : {}),
  };
}

export function parseIdentityBags(raw: unknown): { bags: string[]; bag_configs: Record<string, IdentityBagConfiguration> } {
  if (raw === undefined) return { bags: [], bag_configs: {} };
  if (!raw || typeof raw !== "object") throw new TypeError("identity bags must be a list or mapping");
  const bags = new Set<string>();
  const bag_configs: Record<string, IdentityBagConfiguration> = {};
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    if (typeof entry === "string") { bags.add(nameSchema.parse(entry)); continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("identity bag entries must be names or mappings");
    if (Array.isArray(raw) && Object.keys(entry).length !== 1) throw new TypeError("each identity bag override must name exactly one bag");
    for (const [name, value] of Object.entries(entry)) {
      nameSchema.parse(name);
      bags.add(name);
      const configuration = IdentityBagConfigurationSchema.parse(value ?? {});
      bag_configs[name] = mergeBagConfiguration(Object.hasOwn(bag_configs, name) ? bag_configs[name] : undefined, configuration);
    }
  }
  return { bags: [...bags], bag_configs };
}

export function serializeIdentityBags(bags: readonly string[], configurations: Readonly<Record<string, IdentityBagConfiguration>> = {}): IdentityBags {
  const names = [...new Set(bags.map((bag) => BagNameSchema.parse(bag)))];
  for (const name of Object.keys(configurations)) {
    if (!names.includes(name)) throw new Error(`configuration names unselected bag ${name}`);
  }
  return names.map((name) => {
    const configuration = configurations[name] ?? {};
    if (!Object.keys(configuration).length) return name;
    const stores = configuration.stores;
    const singular = stores && Object.keys(stores).length === 1 && stores.default;
    return { [name]: {
      ...(configuration.optional ? { optional: true } : {}),
      ...(singular ? { store: stores.default } : stores ? { stores } : {}),
      ...(configuration.tools ? { tools: Object.entries(configuration.tools).map(([tool, visibility]) => ({ [tool]: visibility })) } : {}),
    } };
  });
}

export function requiredIdentityBags(
  bags: readonly string[],
  configurations: Readonly<Record<string, IdentityBagConfiguration>> = {},
): string[] {
  return bags.filter((name) => !configurations[name]?.optional);
}

export function optionalIdentityBags(
  bags: readonly string[],
  configurations: Readonly<Record<string, IdentityBagConfiguration>> = {},
): string[] {
  return bags.filter((name) => Boolean(configurations[name]?.optional));
}

