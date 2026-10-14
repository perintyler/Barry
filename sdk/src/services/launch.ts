import { isAbsolute, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { nodeTsArgv, stableNodePath } from "./node-command.js";

export const EntrySchema = z.string().min(1).refine(value => {
  const normalized = normalize(value);
  return !isAbsolute(value) && !value.includes("\0") && normalized !== ".." && !normalized.startsWith(`..${sep}`)
    && /\.(?:[cm]?[jt]s|tsx)$/.test(value);
}, "entry must name a JavaScript or TypeScript file inside the bag");
export const LaunchShape = {
  entry: EntrySchema.optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
};
export function hasOneLaunch(value: { entry?: string; command?: string }): boolean {
  return (value.entry !== undefined) !== (value.command !== undefined);
}
export function normalizeLaunch(value: { entry?: string; command?: string; args?: string[] }): { entry?: string; command: string; args?: string[] } {
  return { ...(value.entry ? { entry: value.entry } : {}), command: value.command ?? "node", args: value.args };
}

/** Resolve interpreter/dependencies only when launching; metadata remains declarative. */
export function resolveLaunch(value: { entry?: string; command: string; args?: string[] }, bagDirectory: string): { command: string; args: string[] } {
  if (!value.entry) return { command: value.command, args: value.args ?? [] };
  const entry = EntrySchema.parse(value.entry);
  const filename = resolve(bagDirectory, entry);
  const invocation = /\.(?:[cm]?ts|tsx)$/.test(entry) ? nodeTsArgv(filename) : [stableNodePath(), filename];
  return { command: invocation[0], args: [...invocation.slice(1), ...(value.args ?? [])] };
}
