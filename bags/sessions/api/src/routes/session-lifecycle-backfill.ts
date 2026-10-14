// Transcript backfill route for the sessions lifecycle router.
// Extracted verbatim from session-lifecycle.ts for file size; no behavior change.
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import type { serve } from "@barry-rocks/sdk/services/http";
import { createReadStream } from "fs";
import { realpath, stat } from "node:fs/promises";
import { createInterface } from "readline";
import { sep } from "path";
import { appendMessage, getSessionMessages, getSessionRecord } from "../db.js";
import { parseRequestBody, sendProblem } from "../http.js";
import { inSessionOrder } from "../session-appends.js";
import { transcriptRootsFor } from "../transcript-readers.js";
import { parseTranscriptLine } from "./transcript.js";

const log = createLogger("barry-server");

export function registerBackfillRoute(routes: ReturnType<typeof serve>): void {
// POST /sessions/:id/backfill - Backfill missing messages from transcript file
// Called by the session-tracker SessionEnd hook. Responds 202 immediately,
// then reconciles the transcript against persisted messages in the background.
routes.route(sessionsRoutes.backfillSession, async (req, res) => {
  const sessionId = req.params.sessionId;
  const input = parseRequestBody(req, res, sessionsRoutes.backfillSession.body);
  if (!input) return;
  const session = await getSessionRecord(sessionId);
  if (!session) return sendProblem(req, res, 404, "Session not found");
  const recorded = session.metadata.transcript_path;
  if (typeof recorded !== "string" || !recorded || (input.transcriptPath !== undefined && input.transcriptPath !== recorded)) {
    return sendProblem(req, res, 400, "Recorded transcript path required");
  }
  let transcriptPath: string;
  try {
    transcriptPath = await realpath(recorded);
    const roots = await transcriptRootsFor(session.metadata.provider ?? "", { cwd: session.metadata.working_directory, metadata: session.metadata });
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
    if (!canonicalRoots.some(root => root !== null && transcriptPath.startsWith(root + sep)) || !(await stat(transcriptPath)).isFile()) {
      return sendProblem(req, res, 400, "Transcript is outside declared adapter roots");
    }
  } catch {
    return sendProblem(req, res, 400, "Recorded transcript is unavailable");
  }

  // Validate ownership and real paths before acknowledging background reconciliation.
  res.status(202).json({ ok: true });

  try {
    await backfillFromTranscript(sessionId, transcriptPath);
  } catch (err) {
    log.error("sessions.backfill_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
});
}

/**
 * Parse the transcript JSONL and insert any messages missing from the DB.
 *
 * Matching strategy: build a set of "fingerprints" from existing DB messages
 * (role+first-200-chars for text, name for tool calls at each position).
 * Transcript entries that don't match an existing fingerprint get inserted.
 */
async function backfillFromTranscript(sessionId: string, transcriptPath: string): Promise<void> {
  const { messages: existing } = await getSessionMessages(sessionId, { limit: 10000 });
  const existingUserTexts = new Set<string>();
  const existingAssistantTexts = new Set<string>();

  for (const msg of existing) {
    const m = msg;
    const content = typeof m.content === "string" ? m.content : "";
    const fingerprint = content.slice(0, 200).trim();
    if (m.role === "user" || m.type === "text" && m.role === "user") {
      existingUserTexts.add(fingerprint);
    } else if (m.role === "assistant" || m.type === "text" && m.role === "assistant") {
      existingAssistantTexts.add(fingerprint);
    }
  }

  // 2. Parse transcript — only extract text messages (user/assistant).
  // Tool calls are already captured by the change-tracker's PostToolUse hook,
  // so we focus the backfill on the text messages that the Stop hook may drop.
  const rl = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
  const transcriptUserTexts: string[] = [];
  const transcriptAssistantTexts: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    const entries = parseTranscriptLine(line);
    for (const entry of entries) {
      if (entry.type === "user") {
        transcriptUserTexts.push(entry.content);
      } else if (entry.type === "assistant") {
        transcriptAssistantTexts.push(entry.content);
      }
    }
  }

  let inserted = 0;

  for (const text of transcriptUserTexts) {
    const fingerprint = text.slice(0, 200).trim();
    if (!fingerprint || existingUserTexts.has(fingerprint)) continue;
    await inSessionOrder(sessionId, () => appendMessage(sessionId, { type: "text", role: "user", content: text }));
    existingUserTexts.add(fingerprint);
    inserted++;
  }

  for (const text of transcriptAssistantTexts) {
    const fingerprint = text.slice(0, 200).trim();
    if (!fingerprint || existingAssistantTexts.has(fingerprint)) continue;
    await inSessionOrder(sessionId, () => appendMessage(sessionId, { type: "text", role: "assistant", content: text }));
    existingAssistantTexts.add(fingerprint);
    inserted++;
  }

  if (inserted > 0) {
    log.info("sessions.backfill_complete", { sessionId, inserted });
  }
}
