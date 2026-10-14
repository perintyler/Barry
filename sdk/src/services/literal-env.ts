import { z } from "zod";

/** Process configuration values are authored literals; credentials use named bindings. */
export const LiteralEnvSchema = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*=[^\0]*$/, "env requires non-secret KEY=VALUE literals without NUL; use secrets for credential names")).superRefine((entries, ctx) => {
  const names = new Set<string>();
  entries.forEach((entry, index) => {
    const name = entry.slice(0, entry.indexOf("="));
    if (names.has(name)) ctx.addIssue({ code: "custom", path: [index], message: `duplicate environment variable ${name}` });
    names.add(name);
  });
});
export interface LiteralEnvValue { name: string; source: "value"; value: string }
export function normalizeLiteralEnv(entries: string[]): LiteralEnvValue[] {
  return entries.map(entry => {
    const separator = entry.indexOf("=");
    return { name: entry.slice(0, separator), source: "value", value: entry.slice(separator + 1) };
  });
}
