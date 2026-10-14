import { describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { PiContinuation } from "./continuation.js";

const model: Model<"anthropic-messages"> = {
  id: "test", name: "test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://invalid.test",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
};
function message(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function runtime(answer: AssistantMessage, execute: (id: string, args: { value: string }) => Promise<{ content: Array<{ type: "text"; text: string }>; details: null }>, inspect?: (messages: unknown) => void) {
  const agent = new Agent({
    initialState: { model, tools: [{ name: "effect", label: "Effect", description: "effect", parameters: Type.Object({ value: Type.String() }), execute: (id, args) => execute(id, args as { value: string }) }] },
    streamFn: (_model, context) => {
      inspect?.(context.messages);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: answer.stopReason as "stop" | "toolUse", message: answer });
      return stream;
    },
  });
  return { agent, harness: new PiContinuation(agent, "configuration", () => {}) };
}

describe("Pi durable tool boundary", () => {
  it("restores the original batch in a fresh runtime without re-proposing calls", async () => {
    const effects: string[] = [];
    const execute = async (id: string, args: { value: string }) => {
      effects.push(`${id}:${args.value}`);
      return { content: [{ type: "text" as const, text: args.value }], details: null };
    };
    const original = runtime(message([
      { type: "toolCall", id: "first", name: "effect", arguments: { value: "one" } },
      { type: "toolCall", id: "second", name: "effect", arguments: { value: "two" } },
    ]), execute);
    const paused = await original.harness.begin("Do work", async () => {});
    expect(paused.type).toBe("interrupted");
    expect(effects).toEqual([]);
    if (paused.type !== "interrupted") throw new Error("Expected pause");
    const bytes = JSON.stringify(paused.continuation);
    await original.harness.close();
    const resumed = runtime(message([{ type: "text", text: "Finished" }]), execute, (messages) => {
      const results = (messages as Array<{ role: string; toolCallId?: string }>).filter((item) => item.role === "toolResult");
      expect(results.map((item) => item.toolCallId)).toEqual(["first", "second"]);
    });
    const outcome = await resumed.harness.restore(JSON.parse(bytes), new Map([["first", { allow: true }], ["second", { allow: false, reason: "No" }]]), {
      authorize: async () => ({ allow: true }), execute: async (_call, effect) => effect(),
    }, async () => {});
    expect(outcome).toMatchObject({ type: "completed", result: "Finished" });
    expect(effects).toEqual(["first:one"]);
    await resumed.harness.close();
  });

  it("blocks incompatible checkpoints, incomplete decisions and revoked authority before effects", async () => {
    let calls = 0;
    const execute = async () => { calls++; return { content: [{ type: "text" as const, text: "ok" }], details: null }; };
    const original = runtime(message([{ type: "toolCall", id: "call", name: "effect", arguments: { value: "original" } }]), execute);
    const paused = await original.harness.begin("Work", async () => {});
    if (paused.type !== "interrupted") throw new Error("Expected pause");
    const resumed = runtime(message([{ type: "text", text: "Denied" }]), execute);
    const effects = { authorize: async () => ({ allow: false as const, reason: "Revoked" }), execute: async <T>(_call: unknown, effect: () => Promise<T>) => effect() };
    await expect(resumed.harness.restore({ ...paused.continuation, harnessVersion: "future" }, new Map(), effects, async () => {})).rejects.toThrow("Incompatible");
    await expect(resumed.harness.restore(paused.continuation, new Map(), effects, async () => {})).rejects.toThrow("complete pending batch");
    await resumed.harness.restore(paused.continuation, new Map([["call", { allow: true }]]), effects, async () => {});
    expect(calls).toBe(0);
  });
});
