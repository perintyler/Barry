/**
 * The subset of a built environment that belongs in the agent process's own
 * environment.
 *
 * Every other declared value still reaches the tools that declared it,
 * through the engine — this is only about what the agent process itself can
 * read. A definition with no `expose` is tool-scoped, so the default is the
 * narrow one.
 *
 * Keyed off the DEFINITIONS rather than the values: a value is just a string
 * and carries no memory of how far it was meant to travel.
 */

import type { Environment } from "./types.js";

export function exposedEnv(
  definitions: Record<string, unknown>,
  env: Environment,
): Record<string, string> {
  const exposed: Record<string, string> = {};
  for (const [varName, definition] of Object.entries(definitions)) {
    if (
      definition &&
      typeof definition === "object" &&
      "expose" in definition &&
      (definition as { expose?: unknown }).expose === "env" &&
      env.vars[varName] !== undefined
    ) {
      exposed[varName] = env.vars[varName];
    }
  }
  return exposed;
}
