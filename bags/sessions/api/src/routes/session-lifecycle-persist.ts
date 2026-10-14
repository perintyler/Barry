// Message-persistence route for the sessions lifecycle router.
// Extracted verbatim from session-lifecycle.ts for file size; no behavior change.
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import type { serve } from "@barry-rocks/sdk/services/http";
import { PersistMessageRequestSchema } from "@barry-rocks/sdk/internal/sessions";
import { record as recordTrackedChange } from "@barry-rocks/tracker-bag";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "path";
import { appendMessage, getSessionRecord } from "../db.js";
import { parseRequestBody, sendProblem } from "../http.js";
import { inSessionOrder } from "../session-appends.js";

const log = createLogger("barry-server");

const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Attribute file changes to sessions in @barry-rocks/tracker-bag. The change-tracker
 * hook reports every tool call here; this is what makes BDiff's session view
 * (and any other "what did this session touch" consumer) work for sessions
 * using built-in agent tools, not just MCP-served ones.
 */
function recordFileChange(sessionId: string, tool: string, metadata: unknown): void {
  if (!FILE_MUTATING_TOOLS.has(tool)) return;
  if (!metadata || typeof metadata !== "object") return;
  const meta = metadata as { file_path?: unknown; cwd?: unknown };
  if (typeof meta.file_path !== "string" || meta.file_path.length === 0) return;

  let filePath = meta.file_path;
  if (!isAbsolute(filePath) && typeof meta.cwd === "string" && meta.cwd.length > 0) {
    filePath = resolvePath(meta.cwd, filePath);
  }

  try {
    recordTrackedChange({ sessionId, filePath, tool });
  } catch (err) {
    log.warn("sessions.file_tracker_record_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerPersistRoutes(routes: ReturnType<typeof serve>): void {
routes.route(sessionsRoutes.persistMessage, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    // Validated against the same schema the OpenAPI spec publishes, so a hook
    // sending a field the contract doesn't declare fails loudly here instead
    // of being silently dropped — which is how tool results went missing.
    const parsed = parseRequestBody(req, res, PersistMessageRequestSchema);
    if (!parsed) return;
    const { type, role, content, name, input, result, metadata, toolUseId, parentToolUseId } = parsed;

    // Reject a write for a session that does not exist, rather than letting it
    // reach the insert and fail the messages -> sessions foreign key. A tracker hook
    // whose session-start never landed otherwise retries forever: each attempt
    // costs a round trip and a stack trace, the messages are unpersistable
    // either way, and the FK error names a constraint rather than the actual
    // problem ("this session was never created"). 404 says that, and tells the
    // hook the retry is pointless.
    const persistSession = await getSessionRecord(sessionId);
    if (!persistSession) {
      log.warn("sessions.persist_unknown_session", { sessionId, type });
      return sendProblem(req, res, 404, "Session not found", `No session ${sessionId} — was it ever started?`);
    }

    // Provenance is resolved server-side from the session rather than sent by
    // the caller. The tracker hooks that drive this endpoint run inside the
    // agent process and have no visibility into which model the session was
    // launched with, and the hook payload has no model field to carry it — so
    // asking them for it would mean inventing a contract they cannot honor.
    // This endpoint already loads the session, so the fact is free here.
    const persistMeta = (persistSession.metadata ?? {}) as Record<string, unknown>;
    const origin = {
      provider: typeof persistMeta.provider === "string" ? persistMeta.provider : null,
      model: typeof persistMeta.model === "string" ? persistMeta.model : null,
      // WHICH ROUTE captured this row — resolved server-side for the same
      // reason the two above are. It is a fact about the endpoint rather than
      // the caller: everything arriving here came from a vendor hook, which is
      // what this endpoint IS, so the channel is knowable without asking.
      //
      // The column has existed since migration 006 and nothing ever wrote it:
      // every message row in the production store carries NULL and none
      // carries a value. A column the schema declares, the store accepts, and no caller
      // fills reads as "capture provenance exists" while recording nothing —
      // and D4's acceptance ("a week of sessions with hooks on and off shows
      // equal message/tool counts") cannot be measured without it, because
      // nothing says which rows arrived by hook.
      channel: "hook" as const,
    };

    // Hook captures carry their channel explicitly; unknown provenance remains null.
    // See docs/decisions/0035-session-route-and-summary-rationale.md.
    if (type === "tool_call") {
      if (!name) {
        return res.status(400).json({ ok: false, error: "name is required for tool_call" });
      }

      recordFileChange(sessionId, name, metadata);

      // Pair call/result rows by toolUseId. Generate an id before insertion when
      // none is supplied, since the store assigns sequence numbers during insertion.
      // See docs/decisions/0035-session-route-and-summary-rationale.md.
      const pairId = toolUseId ?? `call:${randomUUID()}`;
      await inSessionOrder(sessionId, async () => {
        await appendMessage(
          sessionId,
          { type: "tool_start", name, input: input ?? {}, toolUseId: pairId, parentToolUseId },
          null,
          origin,
        );

        // If a result came with the call, bind it to THIS row by id rather than
        // letting the shared pending map match it. That map falls back to the
        // oldest unmatched entry, so a single orphaned tool_call (one persisted
        // without a result) would otherwise absorb the next call's result and
        // shift every subsequent pairing by one.
        if (result != null) {
          await appendMessage(sessionId, {
            type: "tool_result",
            result: typeof result === "string" ? result : JSON.stringify(result),
            toolUseId: pairId,
          });
        }
      });

      res.json({ ok: true });
      return;
    }

    // A session summary, from the summarize-sessions job.
    if (type === "summary") {
      if (typeof content !== "string" || !content) {
        return res.status(400).json({ ok: false, error: "content is required for summary" });
      }
      const status = typeof metadata?.status === "string" ? metadata.status : persistSession.status;
      await inSessionOrder(sessionId, () => appendMessage(sessionId, { type: "summary", content, status }));
      res.json({ ok: true });
      return;
    }

    // Result-only call: a PostToolUse-style hook reporting the outcome of a
    // tool_call persisted earlier. Matched by toolUseId against the pending
    // row, so paired hooks (pre + post) end up on ONE row instead of leaving
    // the tool_call permanently result-less.
    if (type === "tool_result") {
      if (result == null) {
        return res.status(400).json({ ok: false, error: "result is required for tool_result" });
      }
      await inSessionOrder(sessionId, () => appendMessage(sessionId, {
        type: "tool_result",
        result: typeof result === "string" ? result : JSON.stringify(result),
        toolUseId,
      }));
      res.json({ ok: true });
      return;
    }

    // Text message (user or assistant). `content` is typed unknown on the
    // shared schema (the endpoint serves three shapes), so narrow it here.
    if (!type || !role || typeof content !== "string" || !content) {
      return res.status(400).json({ ok: false, error: "type, role, and content are required" });
    }

    if (role !== "user" && role !== "assistant") {
      return res.status(400).json({ ok: false, error: "role must be 'user' or 'assistant'" });
    }

    // resolveModelId ignores the origin for user rows, so passing it here is
    // safe for both roles this endpoint accepts.
    await inSessionOrder(sessionId, () => appendMessage(sessionId, { type: "text", role, content }, null, origin));

    res.json({ ok: true });
  } catch (err) {
    log.error("sessions.persist_message_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to persist message" });
  }
});
}
