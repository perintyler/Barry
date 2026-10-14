import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import type { TokenUsage } from "@barry-rocks/sdk/adapters/models";

export interface AgyStreamMessage {
  event?: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: "ACTIVE" | "DONE" | "ERROR";
    step_type?: string;
    text_delta?: string;
    content?: string;
    duration_seconds?: number;
    tool_name?: string;
    tool_info?: { name?: string; parameters?: unknown; output?: unknown; error?: { message?: string } };
    tool_calls?: Array<{
      id?: string;
      name: string;
      args?: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      total_tokens?: number;
      cache_read_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    structured_output?: unknown;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      total_tokens?: number;
      cache_read_tokens?: number;
    };
  };
}

export function* mapAgyEventToSessionEvents(msg: AgyStreamMessage): Generator<SessionEvent, void, undefined> {
  if (msg.event === "init") {
    if (msg.conversation_id) {
      yield { type: "init", harnessSessionId: msg.conversation_id };
    }
    return;
  }

  if (msg.event === "step_update" && msg.step_update) {
    const su = msg.step_update;

    if (su.text_delta) {
      yield { type: "partial", text: su.text_delta };
    }

    if (su.step_type === "tool" && su.tool_name) {
      const id = `tool-${su.step_index ?? 0}`;
      if (su.state === "ACTIVE") yield { type: "tool_use", id, tool: su.tool_name, input: su.tool_info?.parameters ?? {} };
      else yield { type: "tool_result", id, result: su.tool_info?.error?.message ?? su.tool_info?.output ?? su.content ?? "", error: su.state === "ERROR" };
    }

    if (su.tool_calls && su.tool_calls.length > 0) {
      for (const [idx, call] of su.tool_calls.entries()) {
        const id = call.id ?? `tool-${su.step_index ?? 0}-${idx}`;
        yield {
          type: "tool_use",
          id,
          tool: call.name,
          input: call.args ?? {},
        };
      }
    }

    if (su.step_type === "tool_result" || su.step_type === "tool_response") {
      yield {
        type: "tool_result",
        result: su.content ?? "",
        error: su.state === "ERROR",
      };
    }
    return;
  }

  if (msg.event === "result" && msg.result) {
    const res = msg.result;
    if (res.status === "ERROR" || res.error) {
      yield { type: "error", error: res.error ?? "Antigravity execution failed" };
    } else if (res.response !== undefined) {
      yield { type: "result", result: res.response, ...(res.structured_output !== undefined ? { structured: res.structured_output } : {}) };
    }

    const usage: TokenUsage | undefined = res.usage && typeof res.usage.input_tokens === "number" && typeof res.usage.output_tokens === "number"
      ? {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          ...(res.usage.total_tokens !== undefined ? { totalTokens: res.usage.total_tokens } : {}),
          ...(res.usage.cache_read_tokens !== undefined ? { cacheReadTokens: res.usage.cache_read_tokens } : {}),
        }
      : undefined;

    yield {
      type: "done",
      ...(usage ? { usage } : {}),
      ...(res.num_turns !== undefined ? { turns: res.num_turns } : {}),
      ...(res.duration_seconds !== undefined ? { durationMs: Math.round(res.duration_seconds * 1000) } : {}),
    };
  }
}
