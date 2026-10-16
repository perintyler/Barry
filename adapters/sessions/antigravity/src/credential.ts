import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { instanceEnvValue } from "@barry-rocks/sdk/services";

/**
 * An antigravity session runs on the identity's GEMINI_API_KEY, or, when the
 * identity says so, on the Google account agy is signed into on this Mac. It
 * does not start otherwise.
 *
 * The session gate refuses first; this is the adapter's own floor. Without
 * it, antigravity would authenticate with whatever ambient Google login
 * happened to be cached in ~/.gemini/antigravity-cli/antigravity-oauth-token.
 *
 * The account path is an explicit opt-in, ANTIGRAVITY_AUTH=google-account,
 * because it is the one place Barry lets a session ride a credential that
 * was not declared on the identity. It is read from the session env first,
 * then the host process env, then the instance env file
 * (~/Library/Application Support/Barry/env, via the SDK's instanceEnvValue):
 * a session's env carries only PATH, HOME and the credentials the adapter
 * manifest declares (bags/sessions/api/src/identity-env.ts), and services
 * do not inherit the instance file, so an identity-level definition cannot
 * reach here until a manifest can declare an optional credential. On this
 * Mac the switch therefore lives in the instance env file.
 * It exists because the
 * two quotas are not the same thing: an API key spends the quota of the
 * Google Cloud project that issued it (free tier unless that project has
 * billing), while the signed-in account spends the account's own plan. A
 * paid plan on the account does nothing for a key from an unbilled project,
 * which is how a scheduled job ended up refused with a free-tier 429 while
 * the same agy answered interactively.
 */
export type AntigravityAuth = "api-key" | "google-account";

export const AUTH_ENV = "ANTIGRAVITY_AUTH";
export const GOOGLE_ACCOUNT = "google-account";

/** agy's cached sign-in on this Mac. Copied into a session's isolated home. */
export function cachedSignInPath(home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export function antigravityAuth(
  env: Record<string, string | undefined>,
  host: Record<string, string | undefined> = process.env,
  instance: (key: string) => string | undefined = instanceEnvValue,
): AntigravityAuth {
  const value = env[AUTH_ENV] ?? host[AUTH_ENV] ?? instance(AUTH_ENV);
  return value === GOOGLE_ACCOUNT ? "google-account" : "api-key";
}

export function requireIdentityKey(env: Record<string, string | undefined>, signInPath = cachedSignInPath()): void {
  if (antigravityAuth(env) === "google-account") {
    if (existsSync(signInPath)) return;
    throw new Error(
      `${AUTH_ENV}=${GOOGLE_ACCOUNT} is set, but agy is not signed in on this Mac: ${signInPath} does not exist. ` +
        "Run `agy` once and sign in with the Google account whose plan the session should use.",
    );
  }
  if (env.GEMINI_API_KEY) return;
  throw new Error(
    "An antigravity session authenticates with GEMINI_API_KEY from the identity's declared sources. Add it to the vault:\n" +
      "  barry vault set-env GEMINI_API_KEY <value> --source vault\n" +
      `or define it on the identity, or set ${AUTH_ENV}=${GOOGLE_ACCOUNT} in the instance env file to use the Google account agy is signed into. ` +
      "Barry does not fall back to ambient Google login on its own.",
  );
}
