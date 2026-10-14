import type { OfferedModel } from "@barry-rocks/sdk/adapters/harnesses";

/**
 * Curated list of offered models across common providers supported by Pi.
 */
export const PI_OFFERED_MODELS: readonly OfferedModel[] = [
  { id: "anthropic/claude-fable-5-1", label: "Claude Fable 5.1 (Anthropic)" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5 (Anthropic)" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (Anthropic)" },
  { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic)" },
  { id: "openai/gpt-6-astra", label: "GPT-6 Astra (OpenAI)" },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol (OpenAI)" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra (OpenAI)" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna (OpenAI)" },
  { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex (OpenAI)" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash (Google)" },
  { id: "google/gemini-3.1-pro", label: "Gemini 3.1 Pro (Google)" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro (DeepSeek)" },
  { id: "xai/grok-4.7", label: "Grok 4.7 (xAI)" },
];

/**
 * Read the SDK model catalog without a user profile or stored credential.
 */
export async function listPiModels(): Promise<string[]> {
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const all = runtime.getAllModels();
    if (all && all.length > 0) {
      return all.map((m) => `${m.provider}/${m.id}`);
    }
  } catch {
    /* fallback to offered */
  }

  return PI_OFFERED_MODELS.map((m) => m.id);
}
