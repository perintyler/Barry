import { executionTranscript, AG_UI_PACKAGE_VERSION, APP_EXTENSION_VERSION, PROTOCOL_VERSION, type ExecutionEvent, type PublicSessionSnapshot } from "@barry-rocks/sdk/apps";
import { getDescribeAdapter } from "./agent-runtime.js";
import { getSessionRecord } from "./db.js";
import { turnExecutionService } from "./turn-execution.js";

export async function agUiSnapshot(sessionId: string): Promise<PublicSessionSnapshot> {
  const session = await getSessionRecord(sessionId);
  if (!session) throw new Error("Session not found");
  const state = turnExecutionService().store.publicState(sessionId);
  const adapter = getDescribeAdapter()?.(String(session.metadata?.provider ?? "claude"));
  return {
    threadId: sessionId, turn: state.turn, cursor: state.cursor,
    messages: executionTranscript(state.inputs, state.events as ExecutionEvent[]),
    protocolVersion: PROTOCOL_VERSION, appExtensionVersion: APP_EXTENSION_VERSION, agUiPackageVersion: AG_UI_PACKAGE_VERSION,
    capabilities: { approvalContinuation: adapter?.modes.hosted?.approvalContinuation ?? "unsupported", frontendTools: false, approveWithEdits: false, attachments: true, replay: true },
  };
}
