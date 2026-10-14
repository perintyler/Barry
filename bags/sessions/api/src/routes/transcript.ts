import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Request, Response, Router } from "express";
import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { getSession } from "../db.js";
import type { TranscriptEntry } from "../types.js";
import {
	TranscriptTail,
	nodeStreamPort,
	paginateTranscriptEntries,
	parseJsonFallbackBefore,
	parseJsonFallbackLimit,
	runTranscriptSse,
} from "./transcript-stream.js";

export const transcriptRouter = Router();
const routes = serve(transcriptRouter, "/sessions", { casing: "camel" });

interface TranscriptMessage {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string }>;
  };
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
}

export function parseTranscriptLine(line: string): TranscriptEntry[] {
  try {
    const data: TranscriptMessage = JSON.parse(line);
    const entries: TranscriptEntry[] = [];
    const timestamp = data.timestamp;

    if (data.type === "user" && data.message?.content) {
      const content =
        typeof data.message.content === "string"
          ? data.message.content
          : data.message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (content) {
        entries.push({ type: "user", content, timestamp });
      }
    }

    if (data.type === "assistant" && data.message?.content) {
      if (typeof data.message.content === "string") {
        entries.push({ type: "assistant", content: data.message.content, timestamp });
      } else {
        // Handle array content - extract text and tool_use separately
        const textParts = data.message.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");

        if (textParts) {
          entries.push({ type: "assistant", content: textParts, timestamp });
        }

        for (const block of data.message.content) {
          if (block.type === "tool_use") {
            const toolBlock = block as {
              type: string;
              name?: string;
              input?: unknown;
            };
            entries.push({
              type: "tool_use",
              content: JSON.stringify(toolBlock.input, null, 2),
              tool_name: toolBlock.name,
              timestamp,
            });
          }
        }
      }
    }

    // Handle standalone tool_use (legacy format)
    if (data.type === "tool_use") {
      entries.push({
        type: "tool_use",
        content: JSON.stringify(data.tool_input, null, 2),
        tool_name: data.tool_name,
        timestamp,
      });
    }

    // Handle tool_result
    if (data.type === "tool_result") {
      const result = data.tool_result;
      const content =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      entries.push({ type: "tool_result", content, timestamp });
    }

    return entries;
  } catch {
    return [];
  }
}

// Stream transcript via SSE
routes.route(sessionsRoutes.getSessionTranscript, async (req: Request, res: Response) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: "Session not found" });
  }

  if (!session.transcript_path || !existsSync(session.transcript_path)) {
    return res.status(404).json({ ok: false, error: "Transcript not found" });
  }

  if (req.headers.accept === "text/event-stream") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const tail = new TranscriptTail(session.transcript_path, nodeStreamPort(res));

    // `runTranscriptSse` owns the fix for bug 1 (close-cleanup registered
    // before the initial send) — see its own doc comment. `TranscriptTail`
    // owns bugs 2/3/4 (in-flight guard, backpressure, incremental offset).
    await runTranscriptSse(tail, {
      onClose: (cb) => req.on("close", cb),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
  } else {
    // Paginate the response while acknowledging that source parsing still reads the full file.
    // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
    const limit = parseJsonFallbackLimit(req.query.limit);
    const before = parseJsonFallbackBefore(req.query.before);

    const allEntries: TranscriptEntry[] = [];
    const stream = createReadStream(session.transcript_path);
    const rl = createInterface({ input: stream });

    for await (const line of rl) {
      if (line.trim()) {
        allEntries.push(...parseTranscriptLine(line));
      }
    }

    const page = paginateTranscriptEntries(allEntries, limit, before);
    res.json({ ok: true, ...page });
  }
});
