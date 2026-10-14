import { describe, expect, it, vi } from "vitest";
import {
  listLlamaModels,
  llamaChat,
  llamacppCompletionModel,
  normalizeV1Url,
  usageOf,
} from "./api.js";
import { checkLlama } from "./check.js";

describe("normalizeV1Url", () => {
  it("appends /v1 when missing", () => {
    expect(normalizeV1Url("http://localhost:8080", "chat/completions")).toBe(
      "http://localhost:8080/v1/chat/completions",
    );
    expect(normalizeV1Url("http://localhost:8080/", "models")).toBe(
      "http://localhost:8080/v1/models",
    );
  });

  it("does not duplicate /v1 when already present", () => {
    expect(normalizeV1Url("http://localhost:8080/v1", "chat/completions")).toBe(
      "http://localhost:8080/v1/chat/completions",
    );
    expect(normalizeV1Url("http://localhost:8080/v1/", "/models")).toBe(
      "http://localhost:8080/v1/models",
    );
  });
});

describe("usageOf", () => {
  it("extracts token counts from OpenAI-shaped usage block", () => {
    expect(
      usageOf({
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40,
      },
    });
  });

  it("returns empty object when usage is absent", () => {
    expect(usageOf({})).toEqual({});
  });
});

describe("llamacppCompletionModel", () => {
  it("sends prompt and formats reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chatcmpl-1",
        model: "qwen-7b",
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = llamacppCompletionModel("qwen-7b", { baseUrl: "http://127.0.0.1:8080" });
    const res = await model.complete({ prompt: "ping" });

    expect(res).toEqual({
      text: "pong",
      servedModel: "qwen-7b",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "qwen-7b",
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });
});

describe("listLlamaModels", () => {
  it("lists models from /v1/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "mistral-7b" }, { id: "llama-3-8b" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const listed = await listLlamaModels({ baseUrl: "http://127.0.0.1:8080/v1" });
    expect(listed).toEqual([{ id: "mistral-7b" }, { id: "llama-3-8b" }]);
    vi.unstubAllGlobals();
  });
});

describe("checkLlama", () => {
  it("verifies health and tool calling probe", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve({ ok: true });
      }
      if (url.endsWith("/models")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ id: "llama-3-8b" }] }),
        });
      }
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                    },
                  ],
                },
              },
            ],
          }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const checks = await checkLlama({ baseUrl: "http://127.0.0.1:8080" }, "llama-3-8b");
    expect(checks).toEqual([
      { name: "llama-server", status: "ok", observed: "healthy at http://127.0.0.1:8080" },
      { name: "model loaded", status: "ok", observed: 'model "llama-3-8b" loaded' },
      { name: "tool call", status: "ok", observed: expect.stringContaining("tool call ok") },
    ]);

    vi.unstubAllGlobals();
  });
});
