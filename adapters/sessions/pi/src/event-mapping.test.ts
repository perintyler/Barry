import { describe, expect, it } from "vitest";
import { piEventOf, sumUsage, usageSnapshotOf, usageOf } from "./event-mapping.js";

describe("Pi Event Mapping", () => {
  it("maps message_update text deltas to partial events", () => {
    const signals = piEventOf({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello, world!",
      },
    });

    expect(signals.events).toEqual([{ type: "partial", text: "Hello, world!" }]);
  });

  it("maps user message_end to user text event", () => {
    const signals = piEventOf({
      type: "message_end",
      message: {
        role: "user",
        content: "What is Barry?",
      },
    });

    expect(signals.events).toEqual([{ type: "text", text: "What is Barry?", role: "user" }]);
  });

  it("maps assistant message_end with text and toolCall", () => {
    const signals = piEventOf({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will check the directory." },
          {
            type: "toolCall",
            id: "call-1",
            name: "ls",
            arguments: { path: "." },
          },
        ],
        usage: {
          input: 100,
          output: 25,
          totalTokens: 125,
          cacheRead: 10,
          cost: { total: 0.005 },
        },
      },
    });

    expect(signals.events).toEqual([
      { type: "text", text: "I will check the directory." },
      { type: "tool_use", id: "call-1", tool: "ls", input: { path: "." } },
    ]);
    expect(signals.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadTokens: 10,
      costUsd: 0.005,
    });
    expect(signals.usageSnapshot).toMatchObject({
      status: "known",
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 10,
      total_tokens: 125,
      reported_cost: 0.005,
    });
  });

  it("does not fabricate 0 in usageOf when usage fields are missing or partial, while preserving measured 0", () => {
    expect(usageOf(undefined)).toBeUndefined();
    expect(usageOf({ input: 50 })).toBeUndefined();

    const partialSnap = usageSnapshotOf({ input: 50 });
    expect(partialSnap.status).toBe("partial");
    expect(partialSnap.input_tokens).toBe(50);
    expect(partialSnap.output_tokens).toBeNull();
    expect(partialSnap.unknown_reason).toBe("usage_incomplete");

    const zeroUsage = usageOf({ input: 0, output: 0, totalTokens: 0 });
    expect(zeroUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(usageSnapshotOf({ input: 0, output: 0, totalTokens: 0 }).status).toBe("known");
  });

  it("maps nested tool execution start", () => {
    const signals = piEventOf({
      type: "tool_execution_start",
      parentToolCallId: "parent-1",
      toolCallId: "child-1",
      toolName: "read",
      args: { path: "package.json" },
    });

    expect(signals.events).toEqual([
      {
        type: "tool_use",
        id: "child-1",
        tool: "read",
        input: { path: "package.json" },
        parentToolUseId: "parent-1",
      },
    ]);
  });

  it("maps tool execution end to tool_result", () => {
    const signals = piEventOf({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: "total 0" },
      isError: false,
    });

    expect(signals.events).toEqual([
      {
        type: "tool_result",
        id: "call-1",
        result: "total 0",
      },
    ]);
  });

  it("correctly sums token usage", () => {
    const u1 = { inputTokens: 50, outputTokens: 20, totalTokens: 70, costUsd: 0.001 };
    const u2 = { inputTokens: 30, outputTokens: 10, totalTokens: 40, costUsd: 0.002 };
    const total = sumUsage(u1, u2);
    expect(total).toEqual({
      inputTokens: 80,
      outputTokens: 30,
      totalTokens: 110,
      costUsd: 0.003,
    });
  });
});

