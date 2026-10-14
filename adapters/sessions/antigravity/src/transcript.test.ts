import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agyLineToEvents, antigravityTranscript, extractUserPrompt } from "./transcript.js";

describe("Antigravity transcript reader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "barry-transcript-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("extracts user prompt from XML tags", () => {
    const raw = `<USER_REQUEST>\nFix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime=123\n</ADDITIONAL_METADATA>`;
    expect(extractUserPrompt(raw)).toBe("Fix the build");
  });

  it("maps transcript lines to session events", () => {
    const userLine = {
      step_index: 0,
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nHello world\n</USER_REQUEST>",
    };
    expect(agyLineToEvents(userLine)).toEqual([
      { type: "text", text: "Hello world", role: "user" },
    ]);

    const modelLine = {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "I am on it.",
      tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
    };
    expect(agyLineToEvents(modelLine)).toEqual([
      { type: "text", text: "I am on it.", role: "assistant" },
      { type: "tool_use", id: "step-1-0", tool: "run_command", input: { CommandLine: "ls" } },
    ]);
  });

  it("locates and reads a transcript file on disk", async () => {
    const convId = "conv-xyz-789";
    const logDir = join(tmp, "brain", convId, ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    const transcriptFile = join(logDir, "transcript.jsonl");

    const content = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Hi" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "Hello!" }),
    ].join("\n") + "\n";

    writeFileSync(transcriptFile, content);

    const located = await antigravityTranscript.locate({
      harnessSessionId: convId,
      metadata: { antigravity_data_dir: tmp },
    });
    expect(located).toBe(transcriptFile);

    const scan = await antigravityTranscript.read(located!);
    expect(scan.linesRead).toBe(2);
    expect(scan.entriesParsed).toBe(2);
    expect(scan.events.length).toBe(2);
    expect(scan.events[0].event).toEqual({ type: "text", text: "Hi", role: "user" });
    expect(scan.events[1].event).toEqual({ type: "text", text: "Hello!", role: "assistant" });
  });
});
