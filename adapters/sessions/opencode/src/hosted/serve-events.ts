/**
 * `opencode serve` events as Barry session events, and Barry's rulings as the
 * replies the server expects.
 *
 * Written against what a real 2.0.14 server sends
 * (`__fixtures__/serve-2.0.14.jsonl`), and still what 2.0.24 sends: the live
 * check (`src/live/opencode-live.test.ts`) runs turns, tool calls, rulings,
 * steers and interrupts through it. The first sketch expected
 * `message.part.updated` and `tool.execution.completed`, which neither build
 * emits — a mapping that silently produced nothing.
 *
 * Only item-level events are mapped here. A turn's start, end and usage need
 * the session's own state, so the session reads those itself. Reasoning is
 * dropped, as it is for codex: it is the model's working, not its answer.
 */
import type { PermissionDecision, PermissionRequest, SessionEvent } from "@barry-rocks/sdk/sessions";
import { barryToolName } from "../server/launch-env.js";

/** One server event, as the SSE stream's `data:` line carries it. */
export interface ServeEvent {
  type: string;
  data: Record<string, unknown>;
}

export function serveEventOf(raw: Record<string, unknown>): ServeEvent | null {
  const { type, data } = raw;
  if (typeof type !== "string" || data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return { type, data: data as Record<string, unknown> };
}

/** The opencode session an event belongs to, when it belongs to one. */
export function sessionOf(event: ServeEvent): string | null {
  return typeof event.data.sessionID === "string" ? event.data.sessionID : null;
}

/**
 * The events one server event carries, given the names of the tools called
 * so far: a call names only its id, and the name came with its input.
 */
export function itemEvents(event: ServeEvent, toolNames: ReadonlyMap<string, string>): SessionEvent[] {
  const { data } = event;
  const id = typeof data.id === "string" ? data.id : undefined;
  switch (event.type) {
    case "session.text.delta":
      return typeof data.delta === "string" ? [{ type: "partial", text: data.delta }] : [];
    case "session.text.ended":
      return typeof data.text === "string" ? [{ type: "text", text: data.text, role: "assistant" }] : [];
    case "session.tool.called":
      return id ? [{ type: "tool_use", id, tool: toolNames.get(id) ?? "unknown", input: data.input ?? {} }] : [];
    case "session.tool.success":
      return id ? [{ type: "tool_result", id, result: textOf(data.content) }] : [];
    case "session.tool.failed":
      return id ? [{ type: "tool_result", id, result: messageOf(data.error) ?? "tool call failed", error: true }] : [];
    default:
      return [];
  }
}

/**
 * A permission the server asks for, as Barry's request: a tool on one of the
 * session's MCP servers named as Barry names it (`mcp__<server>__<tool>`),
 * which is what Barry's rulings and denied tools match against.
 */
export function permissionOf(event: ServeEvent, servers: readonly string[] = []): PermissionRequest | null {
  if (event.type !== "permission.asked") return null;
  const { id, action, resources } = event.data;
  if (typeof id !== "string" || typeof action !== "string") return null;
  const named = Array.isArray(resources) ? resources.filter((resource): resource is string => typeof resource === "string") : [];
  return {
    id,
    tool: barryToolName(action, servers),
    input: { resources: named },
    ...(named.length > 0 && named.join(" ") !== "*" ? { description: named.join(" ") } : {}),
  };
}

/** Barry's ruling in the words the reply endpoint takes. */
export function permissionReply(decision: PermissionDecision): { decision: "once" | "always" | "reject"; message?: string } {
  if (decision.allow) return { decision: decision.persist ? "always" : "once" };
  return { decision: "reject", ...(decision.reason ? { message: decision.reason } : {}) };
}

/**
 * The rule that makes every call ask first. opencode's default runs
 * everything unasked, which would leave nothing for Barry to rule on.
 */
export const ASK_EVERY_CALL = [{ action: "*", resource: "*", effect: "ask" }] as const;

/** A step's tokens, which the server reports per step; a turn is its steps' sum. */
export function stepTokensOf(event: ServeEvent): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null {
  if (event.type !== "session.step.ended" && event.type !== "session.step.failed") return null;
  const tokens = event.data.tokens;
  if (tokens === null || typeof tokens !== "object") return null;
  const { input, output, cache } = tokens as { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } };
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  return {
    input: count(input),
    output: count(output),
    cacheRead: count(cache?.read),
    cacheWrite: count(cache?.write),
    cost: count(event.data.cost),
  };
}

/** The message on an error the server reports. */
export function messageOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return typeof error === "string" ? error : undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}
