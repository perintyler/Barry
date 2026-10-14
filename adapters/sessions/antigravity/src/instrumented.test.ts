import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotSupportedInMode } from "@barry-rocks/sdk/sessions";
import { planInstrumented } from "./instrumented.js";
import adapter from "./adapter.js";
import { ANTIGRAVITY_INSTRUMENTED } from "./modes.js";

describe("planInstrumented", () => {
  it("preserves granted native tools when installing instrumented hooks", async () => {
    const plan = await planInstrumented({
      sessionId: "sess-native-grant", cwd: "/repos/app", env: { GEMINI_API_KEY: "synthetic-fixture-key" },
      mcpServers: {}, deniedTools: ["write_to_file"], allowedNativeTools: ["view_file", "write_to_file"],
      options: { relayCommand: "barry hook antigravity" },
    }, adapter.modes.guest!, ANTIGRAVITY_INSTRUMENTED.guarantees);
    const gate = join(plan.cwd!, ".agents", "tool_gate.cjs");
    for (const [tool, decision] of [["view_file", "allow"], ["write_to_file", "deny"], ["run_command", "deny"]]) {
      const result = spawnSync(process.execPath, [gate], {
        input: JSON.stringify({ toolCall: { name: tool, args: {} } }), encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ decision });
    }
  });

  it("configures .agents/hooks.json in the workspace", async () => {
    const plan = await planInstrumented(
      {
        sessionId: "sess-inst",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
        deniedTools: ["run_command"],
        options: { relayCommand: "barry hook antigravity" },
      },
      adapter.modes.guest!,
      ANTIGRAVITY_INSTRUMENTED.guarantees,
    );

    expect(plan.inbox).toBeTruthy();
    expect(plan.guarantees.delivery).toBe("turn-end");
    expect(plan.guarantees.gating).toBe("hooks");
    expect(plan.cwd).toBeTruthy();
    expect(plan.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");

    const hooksPath = join(plan.cwd!, ".agents", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks["barry-inbox"]?.PreInvocation).toBeTruthy();
    expect(hooks["barry-gating"]?.PreToolUse).toBeTruthy();
    expect(hooks["barry-tracking"]?.PreInvocation).toBeTruthy();

    // Verify inbox delivery
    const delivered = await plan.inbox!.deliver({ content: "hello world", from: "peer-session" });
    expect(delivered).toBe(true);

    const inboxDir = join(plan.cwd!, ".agents", "barry-inbox");
    const files = readdirSync(inboxDir);
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
    expect(msg.content).toBe("hello world");
    expect(msg.from).toBe("peer-session");
  });

  it("refuses one-shot prompt in instrumented mode", async () => {
    await expect(
      planInstrumented(
        {
          sessionId: "sess-inst-prompt",
          cwd: "/repos/app",
          env: { GEMINI_API_KEY: "test-gemini-key" },
          mcpServers: {},
          options: { prompt: "run one turn", relayCommand: "barry hook antigravity" },
        },
        adapter.modes.guest!,
        ANTIGRAVITY_INSTRUMENTED.guarantees,
      ),
    ).rejects.toThrow(NotSupportedInMode);
  });

  it("requires relayCommand in options", async () => {
    await expect(
      planInstrumented(
        {
          sessionId: "sess-inst-no-relay",
          cwd: "/repos/app",
          env: { GEMINI_API_KEY: "test-gemini-key" },
          mcpServers: {},
        },
        adapter.modes.guest!,
        ANTIGRAVITY_INSTRUMENTED.guarantees,
      ),
    ).rejects.toThrow(/Barry tracking relay/);
  });
});

