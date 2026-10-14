import { describe, expect, it } from "vitest";
import { createLlamaBridge } from "./bridge.js";

describe("createLlamaBridge", () => {
  it("serves health, models, and virtual completions", async () => {
    const tokens: string[] = [];
    let recordedUsage: unknown = null;

    const bridge = await createLlamaBridge({
      port: 0,
      onToken: (t) => tokens.push(t),
      onUsage: (u) => { recordedUsage = u; },
    });

    try {
      // 1. Health
      const healthRes = await fetch(`${bridge.url}/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json();
      expect(healthJson).toEqual({ status: "ok", model: "default", upstream: false });

      // 2. Models
      const modelsRes = await fetch(`${bridge.url}/v1/models`);
      expect(modelsRes.status).toBe(200);
      const modelsJson = await modelsRes.json();
      expect(modelsJson.data[0].id).toBe("default");

      // 3. OpenAI Chat Completions (streaming)
      const chatRes = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      expect(chatRes.status).toBe(200);
      const sseText = await chatRes.text();
      expect(sseText).toContain("data: ");
      expect(sseText).toContain("[DONE]");
      expect(tokens.length).toBeGreaterThan(0);
      expect(recordedUsage).not.toBeNull();

      const plainRes = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "Hello" }], stream: false }),
      });
      expect((await plainRes.json()).usage).toEqual({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
      expect(recordedUsage).toEqual({ promptTokens: 10, completionTokens: 8, totalTokens: 18 });

      // 4. Anthropic Messages (translation)
      const msgRes = await fetch(`${bridge.url}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "default",
          system: "You are a helpful assistant.",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      });

      expect(msgRes.status).toBe(200);
      const msgJson = await msgRes.json();
      expect(msgJson.role).toBe("assistant");
      expect(msgJson.content[0].type).toBe("text");
      expect(msgJson.usage.input_tokens).toBeGreaterThan(0);
    } finally {
      await bridge.close();
    }
  });
});
