/**
 * The OTLP receiver: claude guest-plus's capture side.
 *
 * A claude TUI launched with the telemetry environment (see
 * `capture/otel-events.ts`) PUSHES here — prompts, assistant text, tool input
 * and output, tokens — from the unmodified interactive binary, with no hooks
 * and no file parsing.
 *
 * OTLP/HTTP JSON posts to `/v1/logs` and `/v1/traces` under the exporter's
 * endpoint, which is why these paths are the vendor's rather than Barry's: the
 * exporter builds them from `OTEL_EXPORTER_OTLP_ENDPOINT` (this API's root)
 * and nothing here gets to choose them.
 *
 * It answers with COUNTERS, not just 200. A receiver that accepts a batch and
 * stores none of it — every record for a session Barry has never seen — is
 * indistinguishable from a healthy one unless it says how many it matched
 *.
 */

import { Router } from "express";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import { telemetrySpansToEvents, telemetryToEvents, type CapturedTelemetry } from "@barry-rocks/sessions-bag/capture";
import { getSessionByProviderSessionId } from "@barry-rocks/sessions-bag/client";
import type { WsMessageInput } from "@barry-rocks/sessions-bag/store/session-records";
import { appendMessage } from "../db.js";
import { inSessionOrder } from "../session-appends.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("sessions.otlp", { transport: "stderr" });


export const otlpRouter = Router();

otlpRouter.post("/logs", async (req, res, next) => {
  try {
    res.json(await persistTelemetry(telemetryToEvents(req.body ?? {})));
  } catch (error) {
    next(error);
  }
});

/**
 * The traces half of the receiver: tool OUTPUT, which claude sends only as an
 * event on the tool's span. Without it an instrumented session's transcript
 * has every tool call and none of their results.
 */
otlpRouter.post("/traces", async (req, res, next) => {
  try {
    res.json(await persistTelemetry(telemetrySpansToEvents(req.body ?? {})));
  } catch (error) {
    next(error);
  }
});

/**
 * Store captured telemetry against the sessions it belongs to, and say how
 * much of it matched: a receiver that stores nothing must not look like one
 * that stored everything. `persisted` counts rows stored: a
 * repeat of a stored record, or a tool result folded into its call, adds none.
 */
async function persistTelemetry(
  captured: CapturedTelemetry[],
): Promise<{ received: number; matched: number; unknownSession: number; persisted: number }> {
  let matched = 0;
  let unknownSession = 0;
  let persisted = 0;

  // Resolving the session once per provider id keeps a 200-record batch to
  // one lookup per session rather than 200.
  const bySession = new Map<string, { providerSessionId: string; items: CapturedTelemetry[] }>();
  const sessionOf = new Map<string, string | null>();

  for (const item of captured) {
    let sessionId = sessionOf.get(item.providerSessionId);
    if (sessionId === undefined) {
      sessionId = (await getSessionByProviderSessionId(item.providerSessionId))?.id ?? null;
      sessionOf.set(item.providerSessionId, sessionId);
    }
    if (!sessionId) {
      // Count capture traffic that cannot be linked to a known session.
      // Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
      unknownSession += 1;
      continue;
    }
    matched += 1;
    const group = bySession.get(sessionId) ?? { providerSessionId: item.providerSessionId, items: [] };
    group.items.push(item);
    bySession.set(sessionId, group);
  }

  for (const [sessionId, group] of bySession) {
    try {
      // In order, and in turn with this process's other appends for the
      // session: the store numbers a row as it inserts it.
      persisted += await inSessionOrder(sessionId, async () => {
        let stored = 0;
        for (const item of group.items) {
          const message = storedFormOf(item.event);
          // A record with no persisted form is dropped here rather than
          // stored as text someone would read as the agent's words.
          if (!message) continue;
          const sequence = await appendMessage(
            sessionId,
            { ...message, channel: "telemetry", dedupeKey: item.dedupeKey },
            group.providerSessionId,
          );
          if (sequence !== null) stored += 1;
        }
        return stored;
      });
    } catch (error) {
      // One session's records failing must not lose another's: the exporter
      // does not resend, so a throw here would drop everything after it.
      diagnostics.error("sessions.capture_persist_failed", { detail: `otel receiver: failed to persist ${group.items.length} record(s) for ${sessionId}:`, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { received: captured.length, matched, unknownSession, persisted };
}

/**
 * A session event as the WS-protocol shape the store persists.
 *
 * The two vocabularies are close but not identical — session events are what
 * harnesses emit, the WS shape is what `persistOne` switches on — and this is
 * the one place that translates. The union narrows per case, so each branch
 * reads its OWN fields, and a SessionEvent variant that needs persisting will
 * not silently fall through.
 */
function storedFormOf(event: SessionEvent): WsMessageInput | null {
  switch (event.type) {
    case "text":
      return { type: "text", role: event.role ?? "assistant", content: event.text };
    case "tool_use":
      return { type: "tool_start", name: event.tool, input: event.input, toolUseId: event.id };
    case "tool_result":
      return {
        type: "tool_result",
        result: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
        toolUseId: event.id,
      };
    case "done":
      return { type: "result", status: "completed", metadata: { usage: event.usage } };
    default:
      // No persisted form. Telemetry carries operational records (decisions,
      // status) that are not things anyone said.
      return null;
  }
}
