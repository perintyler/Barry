import { describe, it, expect, afterEach } from "vitest";
import { normalizeHookInput } from "./normalize.js";

// Provider detection must use discriminating fields; Claude also sends hook_event_name.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-020
describe("normalizeHookInput — provider detection", () => {
  const originalProvider = process.env.BARRY_PROVIDER;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.BARRY_PROVIDER;
    else process.env.BARRY_PROVIDER = originalProvider;
  });

  it("treats a Claude SessionStart payload as claude despite hook_event_name", () => {
    delete process.env.BARRY_PROVIDER;
    const n = normalizeHookInput({
      session_id: "8f3c1d2e-0000-4a1b-9c3d-1122334455aa",
      cwd: "/tmp",
      transcript_path: "/tmp/x.jsonl",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(n.provider).toBe("claude");
    expect(n.session_id).toBe("8f3c1d2e-0000-4a1b-9c3d-1122334455aa");
  });

  it("treats every other Claude hook event as claude too", () => {
    delete process.env.BARRY_PROVIDER;
    for (const event of ["Stop", "PostToolUse", "UserPromptSubmit", "SessionEnd"]) {
      expect(normalizeHookInput({ session_id: "s", hook_event_name: event }).provider).toBe("claude");
    }
  });

  it("detects cursor from cursor_version", () => {
    delete process.env.BARRY_PROVIDER;
    expect(normalizeHookInput({ session_id: "s", cursor_version: "1.0" }).provider).toBe("cursor");
  });

  it("detects cursor from conversation_id", () => {
    delete process.env.BARRY_PROVIDER;
    const n = normalizeHookInput({ conversation_id: "conv-1", cwd: "/tmp" });
    expect(n.provider).toBe("cursor");
    expect(n.session_id).toBe("conv-1");
  });

  it("detects cursor from BARRY_PROVIDER even with a claude-shaped payload", () => {
    process.env.BARRY_PROVIDER = "cursor";
    expect(
      normalizeHookInput({ session_id: "s", hook_event_name: "SessionStart" }).provider,
    ).toBe("cursor");
  });

  it("falls back to BARRY_SESSION_ID only when the payload carries no id", () => {
    delete process.env.BARRY_PROVIDER;
    const previous = process.env.BARRY_SESSION_ID;
    process.env.BARRY_SESSION_ID = "barry-fallback";
    try {
      expect(normalizeHookInput({ cwd: "/tmp" }).session_id).toBe("barry-fallback");
      // A real provider id must always win, otherwise provider_sessions records
      // the Barry id as the provider id and resume passes a bogus --resume arg.
      expect(normalizeHookInput({ session_id: "real-id", cwd: "/tmp" }).session_id).toBe("real-id");
    } finally {
      if (previous === undefined) delete process.env.BARRY_SESSION_ID;
      else process.env.BARRY_SESSION_ID = previous;
    }
  });
});
