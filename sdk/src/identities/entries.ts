import { z } from "zod";
import { BoundSchema, type Bound } from "../bounds/types.js";

export type IdentityEntries = Array<string | Record<string, unknown>>;
export interface BoundEntry { name: string; optional: boolean; bound?: Bound }
const referenceSchema = z.strictObject({ optional: z.boolean().optional() });
const boundSchema = () => BoundSchema.omit({ name: true }).extend({ description: z.string(), optional: z.boolean().optional() });

export function parseBounds(raw: unknown, where = "identity"): BoundEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: bounds must be a list`);
  const names = new Set<string>();
  return raw.map((entry, index) => {
    try {
      let name: string;
      let fields: Record<string, unknown> = {};
      if (typeof entry === "string") name = entry;
      else {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1) throw new Error("expected a name or one name mapped to fields");
        const pair = Object.entries(entry)[0];
        name = pair[0];
        const value = pair[1];
        if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("fields must be a mapping or null");
        fields = (value ?? {}) as Record<string, unknown>;
      }
      if (!name.trim() || name !== name.trim()) throw new Error("name must be non-empty without surrounding spaces");
      if (names.has(name)) throw new Error(`${name} is listed twice`);
      names.add(name);
      if (Object.keys(fields).every(key => key === "optional")) return { name, optional: referenceSchema.parse(fields).optional ?? false };
      if (name.includes(":")) throw new Error(`${name}: identity definitions must have bare names`);
      const { optional = false, ...bound } = boundSchema().parse(fields);
      return { name, optional, bound };
    } catch (error) {
      throw new Error(`${where}: bounds entry ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function inheritEntries<T extends BoundEntry>(parent: readonly T[], own: readonly T[], base: readonly string[] = [], where = "identity"): T[] {
  const entries = new Map(parent.map(entry => [entry.name, { ...entry }]));
  for (const entry of own) {
    if ("bound" in entry && (entries.has(entry.name) || base.includes(entry.name))) throw new Error(`${where}: ${entry.name} is already named by the parent or base identity`);
    const inherited = entries.get(entry.name);
    entries.set(entry.name, { ...inherited, ...entry });
  }
  return [...entries.values()];
}

export function serializeEntries(entries: readonly BoundEntry[]): IdentityEntries {
  return entries.map(entry => {
    let fields: Record<string, unknown> = {};
    if ("bound" in entry && entry.bound) { const { name: _name, ...bound } = entry.bound; fields = { ...bound }; }
    if (entry.optional) fields.optional = true;
    return Object.keys(fields).length ? { [entry.name]: fields } : entry.name;
  });
}
export function requiredNames(entries: readonly BoundEntry[]): string[] { return entries.filter(entry => !entry.optional).map(entry => entry.name); }
export function optionalNames(entries: readonly BoundEntry[]): string[] { return entries.filter(entry => entry.optional).map(entry => entry.name); }

/** Keep own definitions while representing the required names against the current parent. */
export function ownEntries<T extends BoundEntry>(own: readonly T[], parent: readonly T[], names: readonly string[] | null): T[] {
  const selected = new Set(names ?? []);
  const entries = new Map<string, T>();
  for (const entry of own) {
    if ("bound" in entry || (names !== null && entry.optional && !selected.has(entry.name))) entries.set(entry.name, { ...entry, optional: !selected.has(entry.name) });
  }
  for (const name of selected) {
    if (entries.has(name)) continue;
    if (!parent.some(entry => entry.name === name && !entry.optional)) entries.set(name, { name, optional: false } as T);
  }
  if (names !== null) for (const entry of parent) {
    if (!entry.optional && !selected.has(entry.name) && !entries.has(entry.name)) entries.set(entry.name, { name: entry.name, optional: true } as T);
  }
  return [...entries.values()];
}

