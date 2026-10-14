import type { Session, SessionEvent } from "@barry-rocks/sdk/sessions";
import { appendMessage, createProviderSession } from "@barry-rocks/sessions-bag/client";

type Message = Parameters<typeof appendMessage>[1];
export interface SessionRecorder {
  link(providerSessionId: string): Promise<void>;
  message(message: Message): Promise<void>;
}

/** Record the one-shot paths through the same store seam as the API runtime. */
export function trackSession(session: Session, provider: string, model?: string): Session {
  // One append at a time, in the order they were made: the store numbers a
  // message as its insert runs, and a delivery can overlap the event stream.
  let appended: Promise<unknown> = Promise.resolve();
  return withSessionRecorder(session, {
    link: async (id) => { await createProviderSession({ session_id: session.id, provider, provider_session_id: id }); },
    message: async (message) => {
      const append = appended.catch(() => {}).then(() => appendMessage(session.id, message, session.harnessSessionId, { provider, model, channel: "engine" }));
      appended = append;
      await append;
    },
  });
}

export function withSessionRecorder(session: Session, recorder: SessionRecorder): Session {
  let linked: string | null = null;
  const link = async (id: string | null) => {
    if (id && linked !== id) { await recorder.link(id); linked = id; }
  };
  return {
    id: session.id,
    mode: session.mode,
    guarantees: session.guarantees,
    harnessVersion: session.harnessVersion,
    warnings: session.warnings,
    get harnessSessionId() { return session.harnessSessionId; },
    status: () => session.status(),
    deliver: async (content, options) => {
      await recorder.message({ type: "text", role: "user", content });
      return session.deliver(content, options);
    },
    async *events() {
      let result: Extract<SessionEvent, { type: "result" }> | undefined;
      let hasText = false;
      for await (const event of session.events()) {
        await link(event.type === "init" ? event.harnessSessionId : session.harnessSessionId);
        if (event.type === "text" && event.role !== "user") hasText = true;
        if (event.type === "result") result = event;
        if (event.type === "done") {
          if (!hasText && result?.result) await recorder.message({ type: "text", role: "assistant", content: result.result });
          await recorder.message({ type: "result", result: result?.result, error: result?.error, metadata: { ...(event.usage ? { usage: event.usage } : {}), ...(event.turns !== undefined ? { turns: event.turns } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) } });
          result = undefined;
          hasText = false;
        }
        const message = persistedEvent(event);
        if (message) await recorder.message(message);
        yield event;
      }
    },
    interrupt: () => session.interrupt(),
    answer: (request, decision) => session.answer(request, decision),
    close: () => session.close(),
  };
}

function persistedEvent(event: SessionEvent): Message | null {
  const provenance = event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {};
  switch (event.type) {
    case "text": return { type: "text", role: event.role ?? "assistant", content: event.text, ...provenance };
    case "tool_use": return { type: "tool_start", name: event.tool, input: event.input, toolUseId: event.id, ...provenance };
    case "tool_result": return { type: "tool_result", toolUseId: event.id, result: typeof event.result === "string" ? event.result : JSON.stringify(event.result), ...provenance };
    case "result": return null;
    case "error": return { type: "error", content: event.error, ...provenance };
    default: return null;
  }
}
