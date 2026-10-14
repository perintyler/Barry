/**
 * Named bounds, for the processes hosting this bag, which act with the
 * installation's authority. A caller asking on someone's behalf reads them
 * through `Barry.bounds()`.
 */
import { baseIdentityConfig } from "../store/identity-files.js";
import type { Bound } from "@barry-rocks/sdk";
import { Bounds } from "../config/bounds.js";

export const bounds = {
  shipped(): Bound[] {
    return (baseIdentityConfig()?.bounds ?? []).flatMap(entry => entry.bound ? [{ ...entry.bound, name: entry.name }] : []);
  },
  stored: Bounds.list,
  async list(): Promise<Bound[]> {
    const shipped = bounds.shipped();
    const names = new Set(shipped.map(bound => bound.name));
    return [...shipped, ...(await Bounds.list()).filter(row => !names.has(row.name)).map(row => ({ ...row.bound, name: row.name, ...(row.description !== null ? { description: row.description } : {}) }))];
  },
  async get(ref: { name: string }): Promise<Bound | undefined> {
    return (await bounds.list()).find(bound => bound.name === ref.name);
  },
  assertOwnership: Bounds.assertOwnership,
  create: (data: Parameters<typeof Bounds.create>[0]) => Bounds.create(data),
  upsert: (data: Parameters<typeof Bounds.upsertBound>[0]) => Bounds.upsertBound(data),
};
