import { describe, expect, it } from "vitest";
import { mapAgyEventToSessionEvents } from "./event-mapping.js";

describe("mapAgyEventToSessionEvents", () => {
  it("maps init event to session init", () => {
    const events = [
      ...mapAgyEventToSessionEvents({
        event: "init",
        conversation_id: "conv-123",
        init: { cwd: "/work" },
      }),
    ];
    expect(events).toEqual([{ type: "init", harnessSessionId: "conv-123" }]);
  });

  it("maps step_update with text_delta to partial", () => {
    const events = [
      ...mapAgyEventToSessionEvents({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          text_delta: "Hello, ",
        },
      }),
    ];
    expect(events).toEqual([{ type: "partial", text: "Hello, " }]);
  });

  it("maps step_update with tool_calls to tool_use", () => {
    const events = [
      ...mapAgyEventToSessionEvents({
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ACTIVE",
          tool_calls: [
            { id: "call-1", name: "run_command", args: { CommandLine: "ls" } },
          ],
        },
      }),
    ];
    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        tool: "run_command",
        input: { CommandLine: "ls" },
      },
    ]);
  });

  it("maps result event to result and done", () => {
    const events = [
      ...mapAgyEventToSessionEvents({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "All tests passed",
          num_turns: 1,
          duration_seconds: 2.5,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            thinking_tokens: 20,
          },
        },
      }),
    ];
    expect(events).toEqual([
      { type: "result", result: "All tests passed" },
      {
        type: "done",
        turns: 1,
        durationMs: 2500,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      },
    ]);
  });

  it("maps error result to error and done", () => {
    const events = [
      ...mapAgyEventToSessionEvents({
        event: "result",
        result: {
          status: "ERROR",
          error: "Permission denied",
          num_turns: 0,
        },
      }),
    ];
    expect(events).toEqual([
      { type: "error", error: "Permission denied" },
      { type: "done", turns: 0 },
    ]);
  });
});
