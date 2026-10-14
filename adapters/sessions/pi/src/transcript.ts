import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import type { TranscriptEvent, TranscriptScan, TranscriptSource } from "@barry-rocks/sdk/transcripts";

/** One line of pi's transcript, as far as this reader reads it. */
interface PiTranscriptLine {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: string | Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
      input?: unknown;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

/**
 * Encode cwd into Pi's directory naming convention:
 * e.g. `/Users/tyler/repos/barry` -> `--Users-tyler-repos-barry--`
 */
export function encodeCwdToPiSessionDir(cwd: string, home = homedir()): string {
  const resolved = resolve(cwd);
  const flattened = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return join(home, ".pi", "agent", "sessions", `--${flattened}--`);
}

/**
 * Locate the transcript file for a Pi session.
 */
export function findPiTranscriptFile(providerSessionId: string, cwd: string, home = homedir()): string | null {
  const dir = encodeCwdToPiSessionDir(cwd, home);
  if (!existsSync(dir)) return null;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      if (file.includes(providerSessionId)) {
        return join(dir, file);
      }
    }
  } catch {
    /* ignore read errors */
  }

  return null;
}

export const piTranscript: TranscriptSource = {
  async roots() { return [join(homedir(), ".pi", "agent", "sessions")]; },
  async locate(session) {
    if (!session.harnessSessionId || !session.cwd) return null;

    try {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const found = SessionManager.findById(session.cwd, session.harnessSessionId);
      if (found && existsSync(found)) return found;
    } catch {
      /* fallback to filesystem search */
    }

    return findPiTranscriptFile(session.harnessSessionId, session.cwd);
  },

  async read(path: string): Promise<TranscriptScan> {
    const raw = await readFile(path, "utf8").catch(() => "");
    const lines = raw.split("\n");

    const events: TranscriptEvent[] = [];
    let entriesParsed = 0;
    const lineCount = lines.filter((line) => line.trim()).length;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      let parsed: PiTranscriptLine;
      try {
        parsed = JSON.parse(line) as PiTranscriptLine;
      } catch {
        // A partial trailing line is normal while writing.
        continue;
      }

      entriesParsed += 1;
      for (const [offset, event] of lineToEvents(parsed).entries()) {
        events.push({
          key: `${path}:${index}:${offset}`,
          event,
        });
      }
    }

    return { events, linesRead: lineCount, entriesParsed };
  },
};

/** Convert one Pi transcript line into Barry events. */
export function lineToEvents(line: PiTranscriptLine): SessionEvent[] {
  if (line.type !== "message" || !line.message) return [];

  const { role, content, toolCallId, isError } = line.message;
  const events: SessionEvent[] = [];

  if (role === "user" || role === "assistant") {
    if (typeof content === "string" && content) {
      events.push({ type: "text", text: content, role });
    } else if (Array.isArray(content)) {
      const textParts = content
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text!);

      if (textParts.length > 0) {
        events.push({ type: "text", text: textParts.join("\n"), role });
      }

      for (const part of content) {
        if ((part.type === "toolCall" || part.type === "tool_use") && part.name) {
          events.push({
            type: "tool_use",
            tool: part.name,
            input: (part.arguments ?? part.input ?? {}),
            id: part.id ?? part.name,
          });
        }
      }
    }
  } else if (role === "toolResult" && toolCallId) {
    let resultText = "";
    if (typeof content === "string") {
      resultText = content;
    } else if (Array.isArray(content)) {
      resultText = content
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text!)
        .join("\n");
    }
    events.push({
      type: "tool_result",
      id: toolCallId,
      result: resultText,
      ...(isError ? { error: true } : {}),
    });
  }

  return events;
}

/** Check transcript last modified time. */
export async function lastModified(path: string): Promise<number | null> {
  return stat(path)
    .then((s) => s.mtimeMs)
    .catch(() => null);
}
