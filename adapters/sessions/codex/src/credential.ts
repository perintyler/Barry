/**
 * A codex session runs on the identity's OPENAI_API_KEY or does not start.
 *
 * The session gate refuses first; this is the adapter's own floor. Without
 * it, codex would authenticate with whatever key its process happened to
 * inherit.
 */
export function requireIdentityKey(env: Record<string, string | undefined>): void {
  if (env.OPENAI_API_KEY) return;
  throw new Error(
    "A codex session authenticates with OPENAI_API_KEY from the identity's declared sources. Add it to the vault:\n" +
      "  barry vault set-env OPENAI_API_KEY <value> --source vault\n" +
      "or define it on the identity.",
  );
}
