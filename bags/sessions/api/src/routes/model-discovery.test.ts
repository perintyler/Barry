import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverClaudeModels, parseClaudeModels, parseCursorModels, parseOpenCodeModels, useDiscoveredModels } from "./model-discovery.js";
import type { ProviderModels } from "./models.js";

const fallback: ProviderModels = {
  label: "Cursor",
  default: null,
  small: null,
  models: [{ id: "composer-2.5", label: "Composer 2.5", note: "Curated note" }],
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("provider model discovery", () => {
  it("requires an explicit discovery credential and never borrows the service environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-service-key");
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "selected-model", display_name: "Selected model" }] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    expect(await discoverClaudeModels()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(await discoverClaudeModels("request-owned-key")).toEqual([{ id: "selected-model", label: "Selected model" }]);
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/v1/models?limit=1000", expect.objectContaining({ headers: { "x-api-key": "request-owned-key", "anthropic-version": "2023-06-01" } }));
  });
  it("reads Anthropic's model IDs and display names", () => {
    expect(parseClaudeModels({ data: [{ id: "claude-fable-5-1", display_name: "Claude Fable 5.1" }] })).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ]);
  });

  it("uses Cursor's full account list and preserves curated notes", () => {
    const listed = parseCursorModels("Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\nnew-model - New Model\n");
    const result = useDiscoveredModels(fallback, listed);
    expect(result.models.map((model) => model.id)).toEqual(["auto", "composer-2.5", "new-model"]);
    expect(result.models[1]).toEqual({ id: "composer-2.5", label: "Composer 2.5", note: "Curated note" });
    expect(result.source).toBe("live");
    expect(result.stale).toBe(false);
  });

  it("uses OpenCode's provider-qualified IDs without dropping configured providers", () => {
    const models = parseOpenCodeModels("anthropic/claude-opus-5\nopenrouter/~deepseek/deepseek-flash-latest\nopencode/mimo-v2.5-free\n");
    expect(models.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-5", "openrouter/~deepseek/deepseek-flash-latest", "opencode/mimo-v2.5-free",
    ]);
  });

  it("marks failed discovery as an incomplete fallback", () => {
    const result = useDiscoveredModels(fallback, []);
    expect(result.models).toEqual(fallback.models);
    expect(result.source).toBe("curated");
    expect(result.stale).toBe(true);
  });
});
