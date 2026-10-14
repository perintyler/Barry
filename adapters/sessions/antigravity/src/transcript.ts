import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import type { TranscriptEvent, TranscriptScan, TranscriptSource } from "@barry-rocks/sdk/transcripts";

interface AgyTranscriptLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  created_at?: string;
  tool_calls?: Array<{
    name: string;
    args?: unknown;
  }>;
}

export function transcriptDir(dataDir?: string, home = homedir()): string {
  return join(dataDir ?? join(home, ".gemini", "antigravity-cli"), "brain");
}

export function transcriptPath(conversationId: string, dataDir?: string, home = homedir()): string {
  return join(transcriptDir(dataDir, home), conversationId, ".system_generated", "logs", "transcript.jsonl");
}

export function extractUserPrompt(raw: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
  if (match) return match[1].trim();
  return raw;
}

export function agyLineToEvents(line: AgyTranscriptLine): SessionEvent[] {
  const events: SessionEvent[] = [];

  if (line.type === "USER_INPUT" && line.content) {
    events.push({
      type: "text",
      text: extractUserPrompt(line.content),
      role: "user",
    });
    return events;
  }

  if (line.type === "PLANNER_RESPONSE") {
    if (line.content) {
      events.push({
        type: "text",
        text: line.content,
        role: "assistant",
      });
    }
    if (line.tool_calls && line.tool_calls.length > 0) {
      for (const [idx, call] of line.tool_calls.entries()) {
        events.push({
          type: "tool_use",
          id: `step-${line.step_index ?? 0}-${idx}`,
          tool: call.name,
          input: call.args ?? {},
        });
      }
    }
    return events;
  }

  if (line.type === "GENERIC" && line.content !== undefined) {
    events.push({
      type: "tool_result",
      result: line.content,
      error: line.status === "ERROR",
    });
    return events;
  }

  return events;
}

export const antigravityTranscript: TranscriptSource = {
  async roots(session) {
    const configured = session.metadata?.antigravity_data_dir;
    const dataDir = typeof configured === "string" && configured ? configured : process.env.ANTIGRAVITY_DATA_DIR;
    const configuredHome = session.metadata?.home ?? session.metadata?.workspace_dir;
    const home = typeof configuredHome === "string" && configuredHome ? configuredHome : homedir();
    return [transcriptDir(dataDir, home), transcriptDir(dataDir)];
  },
  async locate(session) {
    if (typeof session.metadata?.transcript_path === "string" && existsSync(session.metadata.transcript_path)) {
      return session.metadata.transcript_path;
    }

    const conversationId = session.harnessSessionId;
    if (!conversationId) return null;

    const dataDir = (session.metadata?.antigravity_data_dir as string | undefined) ?? process.env.ANTIGRAVITY_DATA_DIR;
    const home = (session.metadata?.home as string | undefined) ?? (session.metadata?.workspace_dir as string | undefined) ?? homedir();
    const file = transcriptPath(conversationId, dataDir, home);
    if (existsSync(file)) return file;

    const defaultFile = transcriptPath(conversationId, dataDir, homedir());
    return existsSync(defaultFile) ? defaultFile : null;
  },

  async read(path: string): Promise<TranscriptScan> {
    const raw = await readFile(path, "utf8").catch(() => "");
    const lines = raw.split("\n");
    const lineCount = lines.filter((l) => l.trim()).length;

    const events: TranscriptEvent[] = [];
    let entriesParsed = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      let parsed: AgyTranscriptLine;
      try {
        parsed = JSON.parse(line) as AgyTranscriptLine;
      } catch {
        /* mid-write */
        continue;
      }

      entriesParsed += 1;
      const stepEvents = agyLineToEvents(parsed);
      for (const [offset, event] of stepEvents.entries()) {
        events.push({
          key: `${path}:${index}:${offset}`,
          event,
        });
      }
    }

    return { events, linesRead: lineCount, entriesParsed };
  },
};
