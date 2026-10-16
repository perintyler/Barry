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

  it("preserves and deduplicates provider usage across tool-call interruption and restore", async () => {
    const { DEFAULT_PI_IMPLEMENTATION_VERSION, createDefaultExecutionBinding } = await import("../inference-bounds.js");
    const { createInMemoryUsageReconcilePort } = await import("../inference-reconciliation.js");
    const { createInMemoryUsageSink } = await import("../inference-usage.js");
    const reconcilePort = createInMemoryUsageReconcilePort();
    const sink = createInMemoryUsageSink();
    const binding = createDefaultExecutionBinding({
      work_id: "work-cont-1",
    });
    const policy = {
      version: 1 as const,
      binding,
      session_id: "sess-cont-1",
      turn_id: "turn-cont-1",
      segment_id: "seg-cont-1",
      accepted_profile_digest: "d".repeat(64),
      endpoint_ref: "endpoint://anthropic",
      provider_protocol: "anthropic-messages" as const,
      implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
      model: "test",
      deadline: 4_102_444_800_000,
      max_calls: null,
      max_input_tokens: null,
      max_output_tokens: 256,
      max_cost: null,
      fallback_policy: "none" as const,
      accounting_policy: "reconciled" as const,
    };

    const execute = async (_id: string, args: { value: string }) => ({
      content: [{ type: "text" as const, text: args.value }],
      details: null,
    });

    const firstTurnMsg = message([
      { type: "toolCall", id: "tc-1", name: "effect", arguments: { value: "step-1" } },
    ]);
    firstTurnMsg.usage = {
      input: 40,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 55,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const agent1 = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "effect",
            label: "Effect",
            description: "effect",
            parameters: Type.Object({ value: Type.String() }),
            execute: (id, args) => execute(id, args as { value: string }),
          },
        ],
      },
      streamFn: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        void options?.onProviderStreamEvent?.(
          { type: "message_start", message: { usage: { input_tokens: 40 } } },
          model,
        );
        void options?.onProviderStreamEvent?.(
          { type: "message_delta", usage: { output_tokens: 15 } },
          model,
        );
        void options?.onProviderStreamEvent?.(
          { type: "message_stop" },
          model,
        );
        stream.push({ type: "done", reason: "toolUse", message: firstTurnMsg });
        return stream;
      },
    });

    const h1 = new PiContinuation(agent1, "configuration", () => {}, {
      inferencePolicy: policy,
      usageSink: sink,
      usageReconcilePort: reconcilePort,
    });

    const paused = await h1.begin("Run tool", async () => {});
    expect(paused.type).toBe("interrupted");
    if (paused.type !== "interrupted") throw new Error("Expected interrupted");

    const secondTurnMsg = message([{ type: "text", text: "All done" }]);
    secondTurnMsg.usage = {
      input: 60,
      output: 25,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 85,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const agent2 = new Agent({
      initialState: { model, tools: agent1.state.tools },
      streamFn: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        void options?.onProviderStreamEvent?.(
          { type: "message_start", message: { usage: { input_tokens: 60 } } },
          model,
        );
        void options?.onProviderStreamEvent?.(
          { type: "message_delta", usage: { output_tokens: 25 } },
          model,
        );
        void options?.onProviderStreamEvent?.(
          { type: "message_stop" },
          model,
        );
        stream.push({ type: "done", reason: "stop", message: secondTurnMsg });
        return stream;
      },
    });

    const h2 = new PiContinuation(agent2, "configuration", () => {}, {
      inferencePolicy: policy,
      usageSink: sink,
      usageReconcilePort: reconcilePort,
      modelCallId: "seg-cont-1:call-2",
    });

    const completed = await h2.restore(
      paused.continuation,
      new Map([["tc-1", { allow: true }]]),
      {
        authorize: async () => ({ allow: true }),
        execute: async (_call, effect) => effect(),
      },
      async () => {},
    );

    expect(completed).toMatchObject({ type: "completed", result: "All done" });
    const reconciledCalls = reconcilePort.getByWorkId("work-cont-1");
    expect(reconciledCalls).toHaveLength(2);
    expect(reconciledCalls[0]!.aggregate).toMatchObject({
      status: "known",
      finality: "final",
      input_tokens: 40,
      output_tokens: 15,
      total_tokens: 55,
    });
    expect(reconciledCalls[1]!.aggregate).toMatchObject({
      status: "known",
      finality: "final",
      input_tokens: 60,
      output_tokens: 25,
      total_tokens: 85,
    });

    await h1.close();
    await h2.close();
  });
});

