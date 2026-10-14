import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { approvalDecisions, attachmentIdsForRun, messageRunInput, parseRunAgentInput, projectAgUi, agUiSse, type ExecutionEvent } from "./ag-ui.js";
import type { TurnSnapshot } from "../sessions/index.js";

const snapshot: TurnSnapshot = {
  id: "turn", sessionId: "session", runId: "run", state: "waiting_for_input", revision: 2, reviewPolicy: { mode: "review_required" },
  interrupts: [{ id: "approval", runId: "run", call: { id: "original-call", tool: "write", input: { value: "exact" } }, status: "pending" }],
};
describe("AG-UI projection", () => {
  it("builds retries from the server transcript and rejects ID reuse or concurrent messages", () => {
    const initial = { threadId: "session", turn: null, cursor: 0, messages: [], protocolVersion: "1", appExtensionVersion: 2, agUiPackageVersion: "1.0.1", capabilities: { approvalContinuation: "durable" as const, frontendTools: false, approveWithEdits: false, attachments: true, replay: true } };
    const first = messageRunInput(initial, "hello", "message", "run");
    expect(first.messages).toEqual([{ id: "message", role: "user", content: "hello" }]);
    const retry = { ...initial, messages: first.messages, turn: { ...snapshot, runId: "run", state: "running" as const } };
    expect(messageRunInput(retry, "hello", "message", "run")).toEqual(first);
    expect(() => messageRunInput(retry, "changed", "message", "run")).toThrow("retry");
    expect(() => messageRunInput(initial, "next", "next-message", "next-run")).not.toThrow();
    expect(() => messageRunInput({ ...initial, turn: snapshot }, "next", "next-message", "next-run")).toThrow("active");
  });
  it("accepts only the documented Barry attachment extension", () => {
    const request = parseRunAgentInput({ threadId: "session", runId: "run", messages: [] }, "session");
    const props = { barry: { attachmentIds: ["att_0123456789abcdef"] } };
    expect(attachmentIdsForRun({ ...request, forwardedProps: props })).toEqual(props.barry.attachmentIds);
    expect(() => attachmentIdsForRun({ ...request, forwardedProps: { barry: { attachmentIds: ["../foreign"] } } })).toThrow();
    expect(() => attachmentIdsForRun({ ...request, forwardedProps: { ...props, toolResults: [] } })).toThrow();
    expect(() => attachmentIdsForRun({ ...request, forwardedProps: props, resume: [{ interruptId: "approval", status: "resolved", payload: { approved: true } }] })).toThrow("cannot add attachments");
  });
  it("validates public events against the pinned upstream schemas and links resume results", () => {
    const records: ExecutionEvent[] = [
      { sequence: 1, turnId: "turn", runId: "run", event: { type: "segment_started" } },
      { sequence: 2, turnId: "turn", runId: "run", event: { type: "partial", text: "Hello" } },
      { sequence: 3, turnId: "turn", runId: "run", event: { type: "tool_use", ...snapshot.interrupts[0].call } },
      { sequence: 4, turnId: "turn", runId: "run", event: { type: "segment_interrupted", snapshot } },
      { sequence: 5, turnId: "turn", runId: "resume", event: { type: "segment_started" } },
      { sequence: 6, turnId: "turn", runId: "resume", event: { type: "tool_result", id: "original-call", result: { content: [{ type: "text", text: "Done" }] } } },
      { sequence: 7, turnId: "turn", runId: "resume", event: { type: "turn_finished", snapshot: { ...snapshot, runId: "resume", state: "completed" } } },
    ];
    const events = records.flatMap((record) => projectAgUi("session", record));
    for (const event of events) expect(EventSchema.safeParse(event).success).toBe(true);
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(2);
    expect(events.filter((event) => event.type === EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({ toolCallId: "original-call", content: "Done" });
    expect(agUiSse("session", records[2])).toContain("id: 3:2");
    expect(JSON.stringify(events)).not.toContain("configFingerprint");
  });

  it("refuses client-authoritative inputs and validates approval payloads", () => {
    const request = { threadId: "session", runId: "run", messages: [] };
    expect(parseRunAgentInput(request, "session")).toMatchObject({ tools: [], context: [] });
    expect(() => parseRunAgentInput(request, "foreign")).toThrow("threadId");
    expect(() => parseRunAgentInput({ ...request, state: { fabricated: true } }, "session")).toThrow("not supported");
    const input = parseRunAgentInput({ ...request, resume: [{ interruptId: "approval", status: "resolved", payload: { approved: true } }] }, "session");
    expect(approvalDecisions(input)).toEqual([{ interruptId: "approval", decision: { allow: true } }]);
    expect(() => approvalDecisions({ ...input, resume: [{ interruptId: "approval", status: "resolved", payload: { approved: true, arguments: { edited: true } } }] })).toThrow("Approval payload");
  });
});
