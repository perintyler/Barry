/**
 * Reading cursor's transcript.
 *
 * The property that matters here is a negative one: cursor's transcript
 * carries tool CALLS but no results. A reader that emitted an empty
 * `tool_result` to make the shape look complete would claim the tool produced
 * nothing — which is worse than the gap, because the gap is declared on the
 * mode and a wrong result is not.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorTranscript, transcriptDir } from "./transcript.js";

function fixture(lines: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cu-tr-")));
  const path = join(dir, "chat.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("reading a cursor transcript", () => {
  it("reads user and assistant turns", async () => {
    const scan = await cursorTranscript.read(
      fixture([
        JSON.stringify({ role: "user", text: "do the thing" }),
        JSON.stringify({ role: "assistant", text: "done" }),
      ]),
    );

    expect(scan.events.map((e: { event: unknown }) => e.event)).toEqual([
      { type: "text", text: "do the thing", role: "user" },
      { type: "text", text: "done", role: "assistant" },
    ]);
  });

  it("emits a tool CALL and does NOT invent a result", async () => {
    // cursor's transcript has no tool output. An empty tool_result here would
    // read as "the command produced nothing", which is a claim rather than a
    // gap — and the gap is already declared on the guest-plus mode, which is
    // why it also installs a postToolUse hook.
    const scan = await cursorTranscript.read(
      fixture([JSON.stringify({ type: "tool_call", toolName: "shell", input: { command: "ls" }, id: "t1" })]),
    );

    expect(scan.events).toHaveLength(1);
    expect(scan.events[0].event).toMatchObject({ type: "tool_use", tool: "shell", id: "t1" });
  });

  it("gives stable keys across re-reads", async () => {
    const path = fixture([
      JSON.stringify({ role: "user", text: "one" }),
      JSON.stringify({ role: "assistant", text: "two" }),
    ]);

    const first = await cursorTranscript.read(path);
    const second = await cursorTranscript.read(path);
    expect(second.events.map((e: { key: string }) => e.key)).toEqual(
      first.events.map((e: { key: string }) => e.key),
    );
  });

  it("counts an empty file as zero lines, not one unparsed", async () => {
    // Otherwise every fresh conversation trips the ratio alert.
    const scan = await cursorTranscript.read(fixture([]));
    expect(scan).toMatchObject({ linesRead: 0, entriesParsed: 0 });
  });

  it("honours a data dir override, so a test never reads the real chats", async () => {
    expect(transcriptDir("/tmp/isolated", "/home")).toBe("/tmp/isolated/agent-transcripts");
    expect(transcriptDir(undefined, "/home")).toContain("/home/.local/share/cursor-agent");
  });

  it("finds a conversation in a session's home, newest launch first, with nothing but its id", async () => {
    const instance = process.env.BARRY_HOME;
    const barry = realpathSync(mkdtempSync(join(tmpdir(), "cu-homes-")));
    vi.stubEnv("BARRY_HOME", barry);
    try {
      const { cursorHome } = await import("./runtime.js");
      const id = "8eaaf4cb-f60e-4a9e-a71f-48aa6522cc34";
      const older = join(cursorHome("s1"), ".cursor", "projects", "ws-old", "agent-transcripts", id);
      const newer = join(cursorHome("s1"), ".cursor", "projects", "ws-new", "agent-transcripts", id);
      mkdirSync(older, { recursive: true });
      mkdirSync(newer, { recursive: true });
      writeFileSync(join(older, `${id}.jsonl`), "{}\n");
      writeFileSync(join(newer, `${id}.jsonl`), "{}\n");
      utimesSync(join(older, `${id}.jsonl`), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
      expect(await cursorTranscript.locate({ harnessSessionId: id })).toBe(join(newer, `${id}.jsonl`));
    } finally {
      // Back to the scratch instance the suite runs in, never to no instance at all.
      vi.unstubAllEnvs();
      rmSync(barry, { recursive: true, force: true });
    }
    expect(process.env.BARRY_HOME).toBe(instance);
  });

  it("reports nothing for a conversation with no directory", async () => {
    expect(
      await cursorTranscript.locate({
        harnessSessionId: "never-existed",
        metadata: { cursor_data_dir: realpathSync(mkdtempSync(join(tmpdir(), "cu-none-"))) },
      }),
    ).toBeNull();
  });
});
