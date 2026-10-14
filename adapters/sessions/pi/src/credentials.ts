/**
 * Which credential a pi session runs on: a provider key from the identity's
 * declared environment. Nothing else.
 *
 * pi resolves a provider key in the order runtime override → credential store
 * → models.json → the provider's environment variables. Barry builds the
 * session's runtime with a store that reads the identity's environment alone
 * and disables models.json, so the only paths left are the identity's:
 * a declared key, or no credential and a session that does not start. The
 * user's own `~/.pi/agent/auth.json` login is never consulted — that is the
 * pi shape of the same ruling that refuses a claude session on the user's
 * subscription: the TUI may run on the user's own login, a Barry
 * session may not.
 *
 * Invariant I10 holds and is asserted by a test: Barry never stores, proxies
 * or redirects a pi credential. `envCredentialStore` reads keys it was handed;
 * it writes nothing. The one environment redirection that would put Barry on
 * the credential path — `PI_CODING_AGENT_DIR`, pi's equivalent of claude's
 * `CLAUDE_CONFIG_DIR` — is refused rather than set.
 */
import type { CredentialStore } from "@earendil-works/pi-ai";

export class CredentialRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRequired";
  }
}

/**
 * Which env vars each pi provider reads, for refusal messages that name the
 * variable to declare.
 */
const PROVIDER_KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  huggingface: ["HF_TOKEN"],
  nvidia: ["NVIDIA_API_KEY"],
  "ant-ling": ["ANT_LING_API_KEY"],
  typesafe: ["TYPESAFE_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
};

/** The env vars a provider reads, as this adapter knows them for messages. */
export function providerKeyEnv(providerId: string): readonly string[] {
  return PROVIDER_KEY_ENV[providerId] ?? [];
}

/** The key an identity's environment declares for a provider, if it declares one. */
export function declaredKeyFor(providerId: string, env: Record<string, string | undefined>): string | undefined {
  const credentialEnvNames = providerKeyEnv(providerId);
  for (const envName of credentialEnvNames) {
    const apiKey = env[envName];
    if (apiKey) return apiKey;
  }
  return undefined;
}

/**
 * The credential store a hosted pi session runs on: the identity's declared
 * keys, and nothing else.
 */
export function envCredentialStore(env: Record<string, string | undefined>): CredentialStore {
  return {
    read: async (providerId) => {
      const apiKey = declaredKeyFor(providerId, env);
      return apiKey ? { type: "api_key" as const, key: apiKey } : undefined;
    },
    list: async () =>
      Object.keys(PROVIDER_KEY_ENV)
        .filter((providerId) => declaredKeyFor(providerId, env) !== undefined)
        .map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: async () => {
      throw new Error("a Barry-hosted pi session never writes a credential — declare the provider key on the identity");
    },
    delete: async () => {
      throw new Error("a Barry-hosted pi session never deletes a credential");
    },
  };
}

/**
 * The adapter-side floor: a session whose model names a provider the
 * environment holds no key for does not start.
 */
export function requireDeclaredKey(
  model: { provider: string; model: string },
  env: Record<string, string | undefined>,
): void {
  if (declaredKeyFor(model.provider, env)) return;
  const credentialEnvNames = providerKeyEnv(model.provider);
  const exampleEnvName = credentialEnvNames.length > 0 ? ` (for example ${credentialEnvNames[0]})` : "";
  throw new CredentialRequired(
    `A pi session on ${model.provider}/${model.model} authenticates with that provider's key from the identity's ` +
      `declared sources. Add it to the vault:\n` +
      `  barry vault set-env <PROVIDER>_API_KEY <value> --source vault\n` +
      `or define it on the identity${exampleEnvName}. Barry does not fall back to the user's own pi login — ` +
      `that authenticates outside the identity.`,
  );
}

/**
 * Environment variables Barry must never set or let a session arrive with.
 */
export const FORBIDDEN_CREDENTIAL_ENV = ["PI_CODING_AGENT_DIR"] as const;
