/** Every session mode requires the identity's declared API key and never stores or redirects vendor credentials; see docs/decisions/0012-credentials-action-runs-and-traits.md. */

export type ClaudeCredential =
  /** An API key, from the identity's environment. The only answer. */
  | { kind: "api-key"; envVar: string };

export class CredentialRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRequired";
  }
}

export interface ResolveCredentialInput {
  /** Every mode is answered the same way. */
  mode: "hosted" | "instrumented" | "guest";
  env: Record<string, string | undefined>;
}

/** Resolve the declared API key or refuse rather than authenticating through an undeclared subscription or login; see docs/decisions/0012-credentials-action-runs-and-traits.md. */
export function resolveClaudeCredential(input: ResolveCredentialInput): ClaudeCredential {
  const apiKey = input.env.ANTHROPIC_API_KEY;
  if (apiKey) return { kind: "api-key", envVar: "ANTHROPIC_API_KEY" };

  throw new CredentialRequired(
    "A claude session authenticates with ANTHROPIC_API_KEY from the identity's declared " +
      "sources. Add it to the vault:\n" +
      "  barry vault set-env ANTHROPIC_API_KEY <value> --source vault\n" +
      "or define it on the identity. Barry does not fall back to a vendor login or a " +
      "subscription — those authenticate outside the identity.",
  );
}

/**
 * Environment variables Barry must NEVER set.
 *
 * Each one would make Barry the holder of a credential it has no business
 * holding:
 *  - `CLAUDE_CODE_OAUTH_TOKEN` is a stored session token (prohibited, §8), and
 *    obtaining one means running `claude setup-token`;
 *  - `CLAUDE_CONFIG_DIR` redirection breaks keychain login AND is the first
 *    step toward Barry owning the credential store (verified E8).
 */
export const FORBIDDEN_CREDENTIAL_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"] as const;
