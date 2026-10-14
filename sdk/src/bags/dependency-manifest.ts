import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { BagDependency } from "./types.js";

const DefinitionSchema = z.object({
  bin: z.string().min(1).refine(value => !value.includes("\0") && (isAbsolute(value) || !value.includes("/")), "bin must be an executable name or absolute path").optional(), reason: z.string().min(1), optional: z.boolean().optional(),
  install: z.object({ macos: z.string().min(1).optional(), linux: z.string().min(1).optional() }).strict().optional(),
}).strict();
const DependencyMapSchema = z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9@._/+:-]*$/), DefinitionSchema).superRefine((definitions, context) => {
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition.bin && name.includes("/")) context.addIssue({ code: "custom", path: [name, "bin"], message: "package keys containing / require an explicit executable bin" });
  }
});
export const DependenciesSchema = z.union([DependencyMapSchema, z.string().min(1).refine(value => {
  const path = normalize(value);
  return !isAbsolute(value) && !value.includes("\0") && path !== ".." && !path.startsWith(`..${sep}`);
}, "dependency file must be inside the bag")]);

/** Static one-argument Brewfile declarations; never execute the file as Ruby. */
function brewfile(contents: string): Record<string, z.infer<typeof DefinitionSchema>> {
  const definitions: Record<string, z.infer<typeof DefinitionSchema>> = {};
  contents.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(?:#.*)?$/.test(line)) return;
    const match = /^\s*(brew|cask)\s+(["'])([a-zA-Z0-9][a-zA-Z0-9@._/+:-]*)\2\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(`Brewfile line ${index + 1}: only static brew or cask declarations are supported`);
    const [, kind, , name] = match;
    if (Object.hasOwn(definitions, name)) throw new Error(`Brewfile line ${index + 1}: duplicate dependency ${name}`);
    definitions[name] = { ...(name.includes("/") ? { bin: basename(name) } : {}), reason: `Declared ${kind} dependency in Brewfile`, install: { macos: `brew install ${kind === "cask" ? "--cask " : ""}${name}` } };
  });
  return definitions;
}

export function normalizeDependencies(raw: z.infer<typeof DependenciesSchema> | undefined, bagDir: string): BagDependency[] {
  if (raw === undefined) return [];
  let source: unknown = raw;
  if (typeof raw === "string") {
    let contents: string;
    try {
      const root = realpathSync(bagDir);
      const file = realpathSync(resolve(bagDir, raw));
      if (!file.startsWith(root + sep)) throw new Error("outside bag");
      contents = readFileSync(file, "utf8");
    } catch {
      throw new Error("dependency file is unavailable inside the bag");
    }
    if (basename(raw) === "Brewfile") source = brewfile(contents);
    else {
      try { source = parse(contents, { uniqueKeys: true }); }
      catch { throw new Error("dependency YAML is invalid"); }
    }
  }
  const parsed = DependencyMapSchema.safeParse(source);
  if (!parsed.success) throw new Error("dependency declarations must be a package map with reason, optional bin, optional and platform install commands");
  const platform = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;
  return Object.entries(parsed.data).map(([name, definition]) => ({
    package: name, name: definition.bin ?? name, reason: definition.reason,
    ...(definition.optional !== undefined ? { optional: definition.optional } : {}),
    ...(platform && definition.install?.[platform] ? { install: definition.install[platform] } : {}),
  }));
}
