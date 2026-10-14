import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { KEY_HELPER_COMMAND } from "./anthropic-compatible/launch.js";
import { CLAUDE_GUEST, CLAUDE_INSTRUMENTED } from "./modes.js";
import { NATIVE_TOOLS } from "./native-tools.js";
import { planInstrumented } from "./instrumented.js";

const GUARANTEES = { instrumented: CLAUDE_INSTRUMENTED.guarantees, guest: CLAUDE_GUEST.guarantees };

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { sessionId: "sess-abc123", cwd: "/repo", env: { ANTHROPIC_API_KEY: "sk-ant-identity" }, mcpServers: {}, ...overrides };
}

function socketOf(plan: LaunchPlan): string {
  return plan.args[plan.args.indexOf("--messaging-socket-path") + 1];
}

function settingsOf(plan: LaunchPlan): Record<string, unknown> {
  return JSON.parse(readFileSync(plan.args[plan.args.indexOf("--settings") + 1], "utf8")) as Record<string, unknown>;
}

describe("an instrumented claude launch", () => {
  it("opens an inbox socket the OS will bind, and accepts deliveries without a confirmation dialog", async () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ["Bash"] } }));

    const plan = await planInstrumented(config({ options: { settingsPath } }), GUARANTEES);

    expect(socketOf(plan)).toMatch(/\.sock$/);
    expect(socketOf(plan).length).toBeLessThanOrEqual(100);
    expect(settingsOf(plan)).toEqual({
      hooks: { Stop: [] },
      permissions: { deny: ["Bash", ...NATIVE_TOOLS.map(tool => `${tool}(*)`)] },
      crossSessionInbound: "accept",
      apiKeyHelper: KEY_HELPER_COMMAND,
    });
    expect(plan.guarantees.delivery).toBe("wake-peer-framed");
    expect(plan.inbox?.guarantee).toBe("wake-peer-framed");
  });

  it("delivers a message into the socket the TUI listens on, as one NDJSON user frame", async () => {
    const plan = await planInstrumented(config(), GUARANTEES);
    const received: string[] = [];
    const tui = createServer((connection) => connection.on("data", (chunk) => received.push(chunk.toString())));
    await new Promise<void>((resolve) => tui.listen(socketOf(plan), resolve));
    try {
      await expect(plan.inbox?.deliver({ content: "from the phone", from: "sess-sender" })).resolves.toBe(true);
      await expect.poll(() => received.join("")).toContain("\n");
      expect(JSON.parse(received.join("").trim())).toEqual({
        type: "user",
        message: { role: "user", content: "from the phone" },
        from: "sess-sender",
      });
    } finally {
      tui.close();
    }
  });

  it("reports an undelivered message when nothing is listening, so it stays queued", async () => {
    const plan = await planInstrumented(config(), GUARANTEES);
    await expect(plan.inbox?.deliver({ content: "anyone?" })).resolves.toBe(false);
  });

  it("captures through telemetry only when there is a receiver, and tells the tracker hooks so", async () => {
    const withReceiver = await planInstrumented(config({ telemetryEndpoint: "http://127.0.0.1:3865" }), GUARANTEES);
    expect(withReceiver.env.BARRY_CAPTURE).toBe("telemetry");
    expect(withReceiver.guarantees.capture).toBe("near-total");

    const without = await planInstrumented(config(), GUARANTEES);
    expect(without.env.BARRY_CAPTURE).toBeUndefined();
    expect(without.guarantees.capture).toBe("post-hoc");
  });

  it("writes its own settings file when the caller has none", async () => {
    const plan = await planInstrumented(config(), GUARANTEES);
    expect(settingsOf(plan)).toEqual({ crossSessionInbound: "accept", apiKeyHelper: KEY_HELPER_COMMAND, permissions: { deny: NATIVE_TOOLS.map(tool => `${tool}(*)`) } });
  });
});
