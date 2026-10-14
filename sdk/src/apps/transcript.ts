import type { Message } from "@ag-ui/core";
import type { ExecutionEvent } from "./ag-ui.js";

/** Build presentation history only from server-accepted input and committed events. */
export function executionTranscript(
  inputs: Array<{ turnId: string; runId: string; input: unknown }>,
  events: ExecutionEvent[],
): Message[] {
  const messages: Message[] = [];
  const assistant = new Map<string, Extract<Message, { role: "assistant" }>>();
  for (const input of inputs) {
    const payload = input.input as { message?: Message } | null;
    if (payload?.message) messages.push(payload.message);
    for (const record of events.filter((event) => event.turnId === input.turnId)) {
      const event = record.event;
      if (event.type === "partial" || event.type === "tool_use") {
        const id = `${record.runId}:assistant`;
        let message = assistant.get(id);
        if (!message) { message = { id, role: "assistant", content: "" }; messages.push(message); assistant.set(id, message); }
        if (event.type === "partial") message.content = `${message.content ?? ""}${event.text}`;
        else message.toolCalls = [...message.toolCalls ?? [], { id: event.id, type: "function", function: { name: event.tool, arguments: JSON.stringify(event.input) } }];
      } else if (event.type === "tool_result" && event.id) {
        const result = event.result as { content?: Array<{ type: string; text?: string }> } | null;
        const content = typeof event.result === "string" ? event.result
          : result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? JSON.stringify(event.result);
        messages.push({ id: `${record.runId}:result:${event.id}`, role: "tool", toolCallId: event.id, content });
      }
    }
  }
  return messages;
}
