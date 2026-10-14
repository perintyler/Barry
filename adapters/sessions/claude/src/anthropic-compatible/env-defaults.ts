/** Apply defaults for bundled vendor features while preserving caller-supplied overrides.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */
export const NONESSENTIAL_FEATURE_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  DISABLE_AUTOUPDATER: "1",
};

/**
 * Fill env defaults without overriding anything the caller already carries.
 * Returns a new object; neither input is mutated.
 */
export function fillEnvDefaults<T extends Record<string, string | undefined>>(
  env: T,
  defaults: Record<string, string>,
): T {
  const merged: T = { ...env };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined) (merged as Record<string, string | undefined>)[key] = value;
  }
  return merged;
}
