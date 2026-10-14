/**
 * pi session events, as Barry's one event vocabulary.
 *
 * Every pi event the session reads passes through here, parsed defensively:
 * the shape comes from the pinned SDK's exported types, but the values come
 * from a live stream, and a reader that throws on an unexpected shape reports
 * "capture broken" where the honest report is "this event was not
 * understood". Anything not understood is dropped, which the coverage
 * counters in the sessions bag make visible instead of silent.
 *
 * The sources are complementary on purpose:
 * - the assistant `message_end` carries the model's tool-call blocks, so a
 *   top-level call is captured the moment the model emits it, before it runs;
 * - `tool_execution_start` with a `parentToolCallId` carries the nested calls
 *   another tool made with `ctx.executeTool()` — those never appear in an
 *   assistant message, so this is the only place they can come from;
 * - `tool_execution_end` carries every call's result, nested included.
 */
import type { TokenUsage } from "@barry-rocks/sdk/adapters/models";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";

/** What one pi event contributed to the turn being read. */
export interface PiEventSignals {
  /** Barry events to emit, in order. */
  events: SessionEvent[];
  /** Usage the event reported, to add to the turn's total. */
  usage?: TokenUsage;
  /** The turn failed, in the model's or pi's own words. */
  error?: string;
}

/** One pi event, or nothing when it is not one this reader understands. */
export function piEventOf(raw: unknown): PiEventSignals {
  const event = asRecord(raw);
  if (!event) return none();
  switch (event.type) {
    case "message_update":
      return signalsOfMessageUpdate(event);
    case "message_end":
      return signalsOfMessageEnd(event);
    case "tool_execution_start":
      return signalsOfToolExecutionStart(event);
    case "tool_execution_end":
      return signalsOfToolExecutionEnd(event);
    default:
      // agent_start, turn_start, queue_update, compaction, retries: turn
      // bookkeeping the session owns, not events Barry's vocabulary carries.
      return none();
  }
}


function signalsOfMessageUpdate(event: Record<string, unknown>): PiEventSignals {
  const delta = asRecord(event.assistantMessageEvent);
  if (delta?.type !== "text_delta" || typeof delta.delta !== "string") return none();
  return { events: [{ type: "partial", text: delta.delta }] };
}

function signalsOfMessageEnd(event: Record<string, unknown>): PiEventSignals {
  const message = asRecord(event.message);
  if (!message || typeof message.role !== "string") return none();
  if (message.role === "user") return { events: userEvents(message) };
  if (message.role === "assistant") return assistantSignals(message);
  // A toolResult message end: its content already arrived through
  // tool_execution_end, which carries the same result once, not twice.
  return none();
}

function userEvents(message: Record<string, unknown>): SessionEvent[] {
  const text = textOf(message.content);
  return text ? [{ type: "text", text, role: "user" }] : [];
}

function assistantSignals(message: Record<string, unknown>): PiEventSignals {
  const events: SessionEvent[] = [];
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text) events.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      events.push({ type: "tool_use", id: block.id, tool: block.name, input: block.arguments });
    }
    // Thinking blocks are the model's, not Barry's, to surface.
  }
  const signals: PiEventSignals = { events };
  const usage = usageOf(message.usage);
  if (usage) signals.usage = usage;
  if (message.stopReason === "error") signals.error = errorTextOf(message) ?? "pi reported an error response";
  return signals;
}


function signalsOfToolExecutionStart(event: Record<string, unknown>): PiEventSignals {
  // Only a nested call: a top-level one already arrived as a tool_use from
  // the assistant message that emitted it, and emitting it twice would double
  // every call in the transcript.
  if (typeof event.parentToolCallId !== "string") return none();
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return none();
  return {
    events: [
      {
        type: "tool_use",
        id: event.toolCallId,
        tool: event.toolName,
        input: event.args,
        parentToolUseId: event.parentToolCallId,
      },
    ],
  };
}

function signalsOfToolExecutionEnd(event: Record<string, unknown>): PiEventSignals {
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return none();
  const toolResult: SessionEvent = {
    type: "tool_result",
    id: event.toolCallId,
    result: resultOf(event.result),
    ...(event.isError === true ? { error: true } : {}),
  };
  if (typeof event.parentToolCallId === "string") toolResult.parentToolUseId = event.parentToolCallId;
  return { events: [toolResult] };
}

/** A tool result as Barry's readers want it: its content, structured when it is. */
function resultOf(raw: unknown): unknown {
  const result = asRecord(raw);
  if (!result) return raw;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    if (text !== undefined) return text;
  }
  return raw;
}


/** pi's `Usage` as Barry's `TokenUsage`. */
export function usageOf(raw: unknown): TokenUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const input = numberOr(usage.input);
  const output = numberOr(usage.output);
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = numberOr(usage.cacheRead);
  const cacheWrite = numberOr(usage.cacheWrite);
  const cost = asRecord(usage.cost);
  const costUsd = cost ? numberOr(cost.total) : undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: numberOr(usage.totalTokens) ?? (input ?? 0) + (output ?? 0),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(costUsd !== undefined && costUsd > 0 ? { costUsd } : {}),
  };
}

/** The turn's total usage: each message's, summed. */
export function sumUsage(total: TokenUsage | undefined, add: TokenUsage | undefined): TokenUsage | undefined {
  if (!add) return total;
  if (!total) return { ...add };
  const costUsd = (total.costUsd ?? 0) + (add.costUsd ?? 0);
  return {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    totalTokens: (total.totalTokens ?? total.inputTokens + total.outputTokens) + (add.totalTokens ?? add.inputTokens + add.outputTokens),
    ...(total.cacheReadTokens !== undefined || add.cacheReadTokens !== undefined
      ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0) }
      : {}),
    ...(total.cacheWriteTokens !== undefined || add.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0) }
      : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}

function errorTextOf(message: Record<string, unknown>): string | undefined {
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  for (const raw of diagnostics) {
    const diagnostic = asRecord(raw);
    if (diagnostic && typeof diagnostic.message === "string" && diagnostic.message) return diagnostic.message;
  }
  return undefined;
}


function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join("\n");
  return text || undefined;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function numberOr(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function none(): PiEventSignals {
  return { events: [] };
}
