import type { AnyToolDefinition } from "./define-tool.js";

export function toolDefinitions(module: Record<string, unknown>): AnyToolDefinition[] {
  const definitions = new Map<string, AnyToolDefinition>();
  for (const candidate of Object.values(module).flatMap(value => Array.isArray(value) ? value : [value])) {
    if (!candidate || typeof candidate !== "object" || !("handler" in candidate)) continue;
    if (typeof candidate.handler !== "function" || typeof candidate.name !== "string" || !candidate.name ||
        typeof candidate.namespace !== "string" || !candidate.namespace ||
        !["read", "write"].includes(candidate.access) || typeof candidate.description !== "string" ||
        !candidate.schema || typeof candidate.schema !== "object") throw new Error("invalid exported tool definition");
    const key = `${candidate.namespace}:${candidate.name}`;
    const previous = definitions.get(key);
    if (previous && previous !== candidate) throw new Error(`duplicate exported tool ${key}`);
    definitions.set(key, candidate);
  }
  return [...definitions.values()];
}
