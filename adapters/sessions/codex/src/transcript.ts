/** Read rollout JSONL for guest backfill; hosted capture comes from engine events.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import { codexHomesRoot, durableCodexHomesRoot, ensureCodexHome } from "./runtime.js";
import type { TranscriptEvent, TranscriptScan, TranscriptSource } from "@barry-rocks/sdk/transcripts";

interface RolloutLine {
  type?: string;
  role?: string;
  text?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  /** Shell calls and their output, on the same record. */
  command?: string;
  aggregated_output?: string;
  call_id?: string;
}

/** Where a session's rollout lives, under the CODEX_HOME Barry owns. */
export function rolloutDir(codexHome?: string, home = homedir()): string {
  if (codexHome) ensureCodexHome(codexHome);
  return join(codexHome ?? join(home, ".codex"), "sessions");
}

export const codexTranscript: TranscriptSource = {
  async roots(session) {
    const home = session.metadata?.codex_home;
    return typeof home === "string" && home ? [rolloutDir(home)] : [...await barryRolloutDirs(), rolloutDir()];
  },
  async locate(session) {
    const threadId = session.harnessSessionId;
    if (!threadId) return null;

    const codexHome = session.metadata?.codex_home as string | undefined;
    // A session Barry launched keeps its rollout in one of Barry's own homes,
    // and the thread id (a UUID) names exactly one. Otherwise the user's own.
    const dirs = codexHome ? [rolloutDir(codexHome)] : [...(await barryRolloutDirs()), rolloutDir()];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      // Rollouts are named by thread id, but nested under date directories whose
      // shape has changed between versions — so the tree is walked for the id
      // rather than a path being constructed from it.
      const found = await findRollout(dir, threadId);
      if (found) return found;
    }
    return null;
  },

  async read(path: string): Promise<TranscriptScan> {
    // `.jsonl.zst` after 7 days. Compressed rollouts are NOT read here: doing
    // it would mean a decompression dependency for a file whose format is
    // already legacy. A compressed rollout simply yields nothing, and the
    // located-nothing counter says so.
    if (path.endsWith(".zst")) return { events: [], linesRead: 0, entriesParsed: 0 };

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

      let parsed: RolloutLine;
      try {
        parsed = JSON.parse(line) as RolloutLine;
      } catch {
        continue;
      }

      entriesParsed += 1;
      for (const [offset, event] of rolloutLineToEvents(parsed).entries()) {
        events.push({ key: `${path}:${index}:${offset}`, event });
      }
    }

    return { events, linesRead: lineCount, entriesParsed };
  },
};

async function barryRolloutDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of [durableCodexHomesRoot(), codexHomesRoot()]) {
    const homes = await readdir(root, { withFileTypes: true }).catch(() => []);
    dirs.push(...homes.filter(home => home.isDirectory() || home.isSymbolicLink()).map(home => join(root, home.name, "sessions")));
  }
  return dirs;
}

async function findRollout(dir: string, threadId: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRollout(full, threadId);
      if (nested) return nested;
    } else if (entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      return full;
    }
  }
  return null;
}

function rolloutLineToEvents(line: RolloutLine): SessionEvent[] {
  // A shell call carries its own output on the same record, unlike cursor's.
  if (line.command) {
    const events: SessionEvent[] = [
      {
        type: "tool_use",
        tool: "shell",
        input: { command: line.command },
        id: line.call_id ?? "shell",
      },
    ];
    if (line.aggregated_output !== undefined) {
      events.push({ type: "tool_result", result: line.aggregated_output, id: line.call_id });
    }
    return events;
  }

  const text =
    typeof line.content === "string"
      ? line.content
      : Array.isArray(line.content)
        ? line.content
            .filter((part) => part.text)
            .map((part) => part.text!)
            .join("\n")
        : line.text;

  if (!text) return [];
  const role = line.role === "user" ? "user" : "assistant";
  return [{ type: "text", text, role }];
}
