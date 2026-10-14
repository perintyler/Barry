import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeCwdToPiSessionDir,
  findPiTranscriptFile,
  lineToEvents,
  piTranscript,
} from "./transcript.js";

describe("Pi Transcript Reader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-transcript-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encodes cwd into expected directory name format", () => {
    const dir = encodeCwdToPiSessionDir("/Users/tyler/repos/barry", "/home");
    expect(dir).toBe("/home/.pi/agent/sessions/--Users-tyler-repos-barry--");
  });

  it("parses single lines into Barry events", () => {
    const userLine = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    };
    expect(lineToEvents(userLine)).toEqual([{ type: "text", text: "Hello", role: "user" }]);

    const assistantLine = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running command" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    };
    expect(lineToEvents(assistantLine)).toEqual([
      { type: "text", text: "Running command", role: "assistant" },
      { type: "tool_use", id: "c1", tool: "bash", input: { command: "ls" } },
    ]);

    const toolResultLine = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "output text" }],
        isError: false,
      },
    };
    expect(lineToEvents(toolResultLine)).toEqual([
      { type: "tool_result", id: "c1", result: "output text" },
    ]);
  });

  it("reads an append-only jsonl transcript file", async () => {
    const filePath = join(tempDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "ses-1" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hi there" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "call-1", content: "file content" },
      }),
    ].join("\n");

    writeFileSync(filePath, lines, "utf8");

    const scan = await piTranscript.read(filePath);
    expect(scan.linesRead).toBe(4);
    expect(scan.entriesParsed).toBe(4);
    expect(scan.events.length).toBe(4);

    expect(scan.events[0].event).toEqual({ type: "text", text: "hello", role: "user" });
    expect(scan.events[1].event).toEqual({ type: "text", text: "hi there", role: "assistant" });
    expect(scan.events[2].event).toEqual({
      type: "tool_use",
      id: "call-1",
      tool: "read",
      input: { path: "a.txt" },
    });
    expect(scan.events[3].event).toEqual({
      type: "tool_result",
      id: "call-1",
      result: "file content",
    });
  });
});
