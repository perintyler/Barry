import { describe, expect, it } from "vitest";
import adapter from "./adapter.js";

describe("a claude TUI launched from inside Claude Code", () => {
  // Claude Code marks its child sessions, and 2.1.282 saves no transcript for
  // them — the transcript Barry captures a guest session from.
  it("still saves its transcript", async () => {
    const plan = await adapter.modes.guest!.plan({
      sessionId: "sess-nested",
      cwd: "/repo",
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-identity", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" },
      mcpServers: {},
    });
    expect(plan.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
  });
});
