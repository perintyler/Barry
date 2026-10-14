import { z } from "zod";
import type { AnyToolDefinition } from "./define-tool.js";

export type ToolVisibility = "enabled" | "deferred" | "disabled";
export const ToolVisibilitySchema = z.array(z.record(z.string().min(1), z.enum(["enabled", "deferred", "disabled"])))
  .superRefine((entries, context) => {
    const names = new Set<string>();
    entries.forEach((entry, index) => {
      const keys = Object.keys(entry);
      if (keys.length !== 1) context.addIssue({ code: "custom", path: [index], message: "each tool override must name exactly one tool" });
      for (const name of keys) {
        if (names.has(name)) context.addIssue({ code: "custom", path: [index], message: `duplicate tool override ${name}` });
        names.add(name);
      }
    });
  }).transform((entries): Record<string, ToolVisibility> => Object.assign({}, ...entries));

export function applyToolVisibility<T extends AnyToolDefinition>(tools: readonly T[], ...overrides: Readonly<Record<string, ToolVisibility>>[]): T[] {
  const names = new Set(tools.map(tool => tool.name));
  const effective = Object.assign({}, ...overrides) as Record<string, ToolVisibility>;
  for (const name of Object.keys(effective)) if (!names.has(name)) throw new Error(`unknown tool override ${name}`);
  return tools.flatMap(tool => effective[tool.name] === "disabled" ? [] : [{ ...tool,
    ...(effective[tool.name] ? { deferred: effective[tool.name] === "deferred" } : {}),
  }]);
}
