import { executionHash, type SessionEvent, type TurnSnapshot } from "@barry-rocks/sdk/sessions";
import type { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { appendMessageSqlite } from "@barry-rocks/sessions-bag/store/sessions-sqlite-writes";
import { getSessionRecord } from "./db.js";
import { recordSessionUsage } from "./telemetry.js";

/** Committed execution remains the source; existing history/search is a retryable projection. */
export async function projectTurnHistory(store: TurnContinuations): Promise<void> {
  for (const record of store.pendingHistory()) {
    const event = record.event as SessionEvent | { type: "segment_started" }
      | { type: "segment_interrupted" | "turn_finished"; snapshot: TurnSnapshot };
    const session = await getSessionRecord(record.sessionId);
    if (!session) throw new Error("Execution history references a missing session");
    const origin = { provider: session.metadata?.provider, model: session.metadata?.model, channel: "ag-ui" };
    const persist = (message: Parameters<typeof appendMessageSqlite>[1]) => appendMessageSqlite(
      record.sessionId, { ...message, channel: "ag-ui", dedupeKey: `ag-ui:${record.sequence}` }, undefined, origin,
    );
    if (event.type === "segment_started" && record.initial) {
      const input = record.input as { message?: { content?: string }; attachmentIds?: string[] };
      await persist({ type: "text", role: "user", content: input.message?.content ?? "", metadata: { turnId: record.turnId, attachmentIds: input.attachmentIds ?? [] } });
    } else if (event.type === "tool_use") {
      await persist({ type: "tool_start", toolUseId: `${record.turnId}:${event.id}`, name: event.tool, input: event.input });
    } else if (event.type === "tool_result" && event.id) {
      const toolUseId = `${record.turnId}:${event.id}`;
      // Results update their original row and have no separate dedupe column.
      // A lost acknowledgement must not leave a duplicate orphan in memory.
      const completed = getSessionsSqlite().prepare("SELECT 1 FROM messages WHERE session_id=? AND type='tool_call' AND json_extract(metadata,'$.toolUseId')=? AND result IS NOT NULL").get(record.sessionId, toolUseId);
      if (!completed) await persist({ type: "tool_result", toolUseId, result: typeof event.result === "string" ? event.result : JSON.stringify(event.result) ?? "" });
    } else if (event.type === "segment_interrupted" || event.type === "turn_finished") {
      const text = store.segmentText(record.sessionId, record.runId, record.sequence);
      if (text) await persist({ type: "text", role: "assistant", content: text, metadata: { turnId: record.turnId, runId: record.runId } });
    } else if (event.type === "usage") {
      recordSessionUsage({ id: executionHash({ turn: record.turnId, run: record.runId, provider: event.id }), sessionId: record.sessionId,
        ...event.usage, model: session.metadata?.model ?? undefined, status: "provider-response", createdAt: Date.parse(record.createdAt) });
    }
    store.acknowledgeHistory(record.sequence);
  }
}
