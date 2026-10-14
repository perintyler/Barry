/**
 * An antigravity session runs on the identity's GEMINI_API_KEY or does not start.
 *
 * The session gate refuses first; this is the adapter's own floor. Without
 * it, antigravity would authenticate with whatever ambient Google login
 * happened to be cached in ~/.gemini/antigravity-cli/antigravity-oauth-token.
 */
export function requireIdentityKey(env: Record<string, string | undefined>): void {
  if (env.GEMINI_API_KEY) return;
  throw new Error(
    "An antigravity session authenticates with GEMINI_API_KEY from the identity's declared sources. Add it to the vault:\n" +
      "  barry vault set-env GEMINI_API_KEY <value> --source vault\n" +
      "or define it on the identity. Barry does not fall back to ambient Google login.",
  );
}
