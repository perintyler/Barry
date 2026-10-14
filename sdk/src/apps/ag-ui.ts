import { EventType, PROTOCOL_VERSION, type Event, type Message, type RunAgentInput } from "@ag-ui/core";
import { EventSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import type { ApprovalDecision, SessionEvent, TurnSnapshot } from "../sessions/index.js";

export const AG_UI_PACKAGE_VERSION = "1.0.1";
export const APP_EXTENSION_VERSION = 2;
export { PROTOCOL_VERSION };
export type { Event as AgUiEvent, RunAgentInput };
/** The AG-UI event type enum, so consumers compare against it without depending on @ag-ui/core. */
export { EventType as AgUiEventType };
export function parseAgUiEvent(value: unknown): Event { return EventSchema.parse(value); }

const BarryInputExtensionsSchema = z.strictObject({
  barry: z.strictObject({
    attachmentIds: z.array(z.string().regex(/^att_[a-f0-9]{16}$/)).max(32).optional(),
    ifActive: z.enum(["error", "queue"]).optional(),
  }),
});

export function barryExtensionsForRun(input: RunAgentInput): { attachmentIds: string[]; ifActive?: "error" | "queue" } {
  if (input.forwardedProps == null) return { attachmentIds: [] };
  const { barry } = BarryInputExtensionsSchema.parse(input.forwardedProps);
  const attachmentIds = barry.attachmentIds ?? [];
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("Duplicate attachment references");
  if (input.resume?.length && attachmentIds.length) throw new Error("Approval resume cannot add attachments");
  return { attachmentIds, ifActive: barry.ifActive };
}

/** Uploaded Barry files are references, not generic multimodal AG-UI input. */
export function attachmentIdsForRun(input: RunAgentInput): string[] {
  return barryExtensionsForRun(input).attachmentIds;
}

export interface ExecutionEvent {
  sequence: number;
  turnId: string;
  runId: string;
  event: SessionEvent | { type: "segment_started" | "resolution_accepted" }
    | { type: "segment_interrupted" | "turn_finished" | "turn_snapshot"; snapshot: TurnSnapshot };
}

/** Validate upstream wire shapes; Barry never forks the AG-UI schema. */
export function parseRunAgentInput(value: unknown, sessionId: string): RunAgentInput {
  const input = RunAgentInputSchema.parse(value);
  if (input.threadId !== sessionId) throw new Error("threadId must match the route session");
  if (input.protocolVersion && input.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported AG-UI protocol version");
  if (input.tools?.length || input.context?.length || input.state != null || input.parentRunId) {
    throw new Error("Client tools, context, state and child runs are not supported");
  }
  return { ...input, tools: input.tools ?? [], context: input.context ?? [] };
}

/** Build an idempotent user-message run from the server-owned transcript. */
export function messageRunInput(snapshot: import("./connection.js").PublicSessionSnapshot, content: string, messageId: string, runId: string): RunAgentInput {
  const existing = snapshot.messages.find((message) => message.id === messageId);
  let messages: Message[];
  if (existing) {
    if (existing.role !== "user" || existing.content !== content || snapshot.turn?.runId !== runId) {
      throw new Error("AG-UI message retry does not match the original run");
    }
    const index = snapshot.messages.indexOf(existing);
    messages = snapshot.messages.slice(0, index + 1);
  } else {
    if (snapshot.turn && !["completed", "failed", "cancelled"].includes(snapshot.turn.state)) {
      throw new Error("Cannot start a new message while the session turn is active");
    }
    messages = [...snapshot.messages, { id: messageId, role: "user", content }];
  }
  return parseRunAgentInput({ threadId: snapshot.threadId, runId, messages }, snapshot.threadId);
}

export function approvalDecisions(input: RunAgentInput): ApprovalDecision[] {
  if (!input.resume?.length) throw new Error("No approval decisions supplied");
  return input.resume.map((entry) => {
    if (entry.status === "cancelled") return { interruptId: entry.interruptId, decision: { allow: false, reason: "Approval cancelled" } };
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.approved !== "boolean" || (payload.reason !== undefined && typeof payload.reason !== "string")
      || Object.keys(payload).some((key) => key !== "approved" && key !== "reason")) {
      throw new Error("Approval payload must contain approved and an optional reason");
    }
    return { interruptId: entry.interruptId, decision: payload.approved
      ? { allow: true } : { allow: false, ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}) } };
  });
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
    return result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  }
  return JSON.stringify(result) ?? "";
}

/** Replay is a projection of committed domain events, never another run loop. */
export function projectAgUi(sessionId: string, record: ExecutionEvent): Event[] {
  const { runId, event } = record;
  const assistantId = `${runId}:assistant`;
  let events: Event[] = [];
  switch (event.type) {
    case "segment_started":
      events = [{ type: EventType.RUN_STARTED, threadId: sessionId, runId }]; break;
    case "partial":
      if (event.text) events = [{ type: EventType.TEXT_MESSAGE_CHUNK, messageId: assistantId, role: "assistant", delta: event.text }]; break;
    case "tool_use":
      events = [
        { type: EventType.TOOL_CALL_START, toolCallId: event.id, toolCallName: event.tool, parentMessageId: assistantId },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: JSON.stringify(event.input) },
        { type: EventType.TOOL_CALL_END, toolCallId: event.id },
      ]; break;
    case "tool_result":
      if (!event.id) throw new Error("A public tool result needs its original call identity");
      events = [{ type: EventType.TOOL_CALL_RESULT, toolCallId: event.id, messageId: `${runId}:result:${event.id}`, role: "tool", content: resultText(event.result) }]; break;
    case "usage":
      events = [{ type: EventType.CUSTOM, name: "barry.usage", value: { id: event.id, usage: event.usage } }]; break;
    case "segment_interrupted":
      events = [{ type: EventType.RUN_FINISHED, threadId: sessionId, runId, outcome: {
        type: "interrupt", interrupts: event.snapshot.interrupts.filter((item) => item.status === "pending").map((item) => ({
          id: item.id, reason: "tool_call", toolCallId: item.call.id, message: `Allow ${item.call.tool}?`,
          responseSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" }, reason: { type: "string" } }, additionalProperties: false },
          ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        })),
      } }]; break;
    case "turn_finished":
      events = event.snapshot.state === "completed"
        ? [{ type: EventType.RUN_FINISHED, threadId: sessionId, runId }]
        : event.snapshot.state === "cancelled"
          ? [{ type: EventType.RUN_FINISHED, threadId: sessionId, runId, outcome: { type: "cancelled" } }]
          : [{ type: EventType.RUN_ERROR, message: event.snapshot.error ?? "Turn requires recovery", code: event.snapshot.state }];
      break;
    case "turn_snapshot": events = [{ type: EventType.STATE_SNAPSHOT, snapshot: { barry: event.snapshot } }]; break;
  }
  return events.map((value) => EventSchema.parse(value) as Event);
}

/** One cursor may project several wire events; index makes every SSE ID stable. */
export function agUiSse(sessionId: string, record: ExecutionEvent): string {
  return projectAgUi(sessionId, record).map((event, index) => `id: ${record.sequence}:${index}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
