/**
 * Reading cursor's `agent-transcripts` jsonl.
 *
 * Written LIVE, which makes it useful for a foreign guest — a Cursor desktop
 * chat Barry never launched leaves this behind and nothing else.
 *
 * **It carries no tool results** (research L4). Tool calls appear; their output
 * does not. That is why cursor's guest-plus tier needs `postToolUse` hooks as
 * well: this reader alone would show an agent running commands and never
 * learning anything, which reads like a broken agent rather than a partial
 * capture. The blind spot is declared on the mode rather than discovered by
 * whoever notices the outputs missing.
 */

import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import type { TranscriptEvent, TranscriptScan, TranscriptSource } from "@barry-rocks/sdk/transcripts";
import { cursorHomesRoot } from "./runtime.js";

interface CursorLine {
  type?: string;
  role?: string;
  text?: string;
  content?: string;
  toolName?: string;
  tool?: string;
  input?: unknown;
  id?: string;
}

/**
 * Where an older cursor kept a conversation's transcript: under its data dir,
 * one directory per conversation. `CURSOR_DATA_DIR` overrides it, which is how
 * a test isolates itself from the user's real chats.
 */
export function transcriptDir(dataDir?: string, home = homedir()): string {
  return join(dataDir ?? join(home, ".local", "share", "cursor-agent"), "agent-transcripts");
}

/**
 * Where the current cursor keeps them: per project, under the home it ran in,
 * `<home>/.cursor/projects/<workspace>/agent-transcripts/<conversation>/`.
 * Barry's sessions run in their own homes, and each launch in a workspace of
 * its own, so a resumed conversation can leave one per launch.
 */
function transcriptDirsIn(home: string, conversationId: string): string[] {
  const projects = join(home, ".cursor", "projects");
  return listed(projects).map((project) => join(projects, project, "agent-transcripts", conversationId));
}

function listed(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export const cursorTranscript: TranscriptSource = {
  async roots(session) {
    const dataDir = session.metadata?.cursor_data_dir;
    if (typeof dataDir === "string" && dataDir) return [transcriptDir(dataDir)];
    const homes = [...listed(cursorHomesRoot()).map(home => join(cursorHomesRoot(), home)), homedir()];
    return [transcriptDir(), ...homes.map(home => join(home, ".cursor", "projects"))];
  },
  async locate(session) {
    const conversationId = session.harnessSessionId;
    if (!conversationId) return null;

    const dataDir = (session.metadata?.cursor_data_dir as string | undefined) ?? undefined;
    const homes = [...listed(cursorHomesRoot()).map((home) => join(cursorHomesRoot(), home)), homedir()];
    const candidates = [
      join(transcriptDir(dataDir), conversationId),
      ...(dataDir ? [] : homes.flatMap((home) => transcriptDirsIn(home, conversationId))),
    ];
    // The name inside a conversation's directory varies by version, so it is
    // listed rather than guessed; the newest wins.
    const found = candidates.flatMap((dir) => listed(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)));
    return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  },

  async read(path: string): Promise<TranscriptScan> {
    const raw = await readFile(path, "utf8").catch(() => "");
    const lines = raw.split("\n");
    // Blank lines are not lines. An empty file, or one holding only a
    // trailing newline, must read as ZERO lines read: counting them as
    // read-but-unparsed is the exact shape of the ratio alert, fired by a
    // file that simply has nothing in it yet.
    //
    // This is a COUNT for the ratio, never a loop bound. Using it as one meant
    // a blank line anywhere but the end shortened the scan: with one blank
    // among four lines, lineCount was 3 and index 3 was never read, so the
    // last entry vanished -- while linesRead/entriesParsed both reported 3/3,
    // which is exactly what a healthy file looks like. N blank lines dropped
    // the last N entries, silently. The loop walks the whole array and skips
    // blanks, so `index` -- which the dedupe key is built from -- still means
    // the same line it always did.
    const lineCount = lines.filter((line) => line.trim()).length;

    const events: TranscriptEvent[] = [];
    let entriesParsed = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      let parsed: CursorLine;
      try {
        parsed = JSON.parse(line) as CursorLine;
      } catch {
        // Mid-write. Normal for a file the vendor is appending to.
        continue;
      }

      entriesParsed += 1;
      for (const [offset, event] of cursorLineToEvents(parsed).entries()) {
        events.push({ key: `${path}:${index}:${offset}`, event });
      }
    }

    return { events, linesRead: lineCount, entriesParsed };
  },
};

function cursorLineToEvents(line: CursorLine): SessionEvent[] {
  const text = line.text ?? line.content;

  if (text && (line.role === "user" || line.type === "user")) {
    return [{ type: "text", text, role: "user" }];
  }
  if (text && (line.role === "assistant" || line.type === "assistant")) {
    return [{ type: "text", text, role: "assistant" }];
  }

  const toolName = line.toolName ?? line.tool;
  if (toolName) {
    // The CALL only. cursor's transcript carries no result, which is why
    // guest-plus also installs a postToolUse hook — emitting an empty
    // tool_result here would claim the tool produced nothing.
    return [{ type: "tool_use", tool: toolName, input: line.input ?? {}, id: line.id ?? toolName }];
  }

  return [];
}
