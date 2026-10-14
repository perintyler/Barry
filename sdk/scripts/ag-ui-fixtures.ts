import { parseRunAgentInput, projectAgUi, AG_UI_PACKAGE_VERSION, APP_EXTENSION_VERSION, PROTOCOL_VERSION } from "../src/apps/ag-ui.js";
import { executionTranscript } from "../src/apps/transcript.js";
import { PublicSessionSnapshotSchema } from "../src/apps/wire.js";
import type { ExecutionEvent } from "../src/apps/ag-ui.js";
import type { TurnSnapshot } from "../src/sessions/continuations.js";

export function agUiWireFixtures() {
  const input = parseRunAgentInput({ threadId: "fixture-session", runId: "fixture-initial", protocolVersion: PROTOCOL_VERSION,
    messages: [{ id: "fixture-user", role: "user", content: "Write the report" }], tools: [], context: [] }, "fixture-session");
  const turn: TurnSnapshot = { id: "fixture-turn", sessionId: input.threadId, runId: input.runId, state: "waiting_for_input", revision: 2,
    reviewPolicy: { mode: "review_required" }, interrupts: [{ id: "fixture-interrupt", runId: input.runId,
      call: { id: "fixture-call", tool: "write", input: { path: "report.md", content: "Original proposal" } }, status: "pending" }] };
  const records: ExecutionEvent[] = [
    { sequence: 1, turnId: turn.id, runId: input.runId, event: { type: "segment_started" } },
    { sequence: 2, turnId: turn.id, runId: input.runId, event: { type: "partial", text: "Preparing the report." } },
    { sequence: 3, turnId: turn.id, runId: input.runId, event: { type: "tool_use", ...turn.interrupts[0]!.call } },
    { sequence: 4, turnId: turn.id, runId: input.runId, event: { type: "segment_interrupted", snapshot: turn } },
  ];
  const snapshot = PublicSessionSnapshotSchema.parse({ threadId: input.threadId, turn, cursor: 4,
    messages: executionTranscript([{ turnId: turn.id, runId: input.runId, input: { message: input.messages[0] } }], records),
    protocolVersion: PROTOCOL_VERSION, appExtensionVersion: APP_EXTENSION_VERSION, agUiPackageVersion: AG_UI_PACKAGE_VERSION,
    capabilities: { approvalContinuation: "durable", frontendTools: false, approveWithEdits: false, attachments: true, replay: true } });
  const resume = parseRunAgentInput({ threadId: input.threadId, runId: "fixture-resume", protocolVersion: PROTOCOL_VERSION,
    messages: snapshot.messages, tools: [], context: [], resume: [{ interruptId: "fixture-interrupt", status: "resolved", payload: { approved: true } }] }, input.threadId);
  return { input, snapshot, resume, events: records.flatMap((record) => projectAgUi(input.threadId, record)) };
}
