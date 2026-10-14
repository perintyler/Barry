import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotSupportedInMode } from "@barry-rocks/sdk/sessions";
import { discoverAntigravityConversationId, planAntigravityLaunch } from "./launch.js";
import { ANTIGRAVITY_GUEST } from "./modes.js";

describe("planAntigravityLaunch", () => {
  it("plans a default guest launch", () => {
    const plan = planAntigravityLaunch(
      {
        sessionId: "sess-1",
        cwd: "/repos/app",
        env: { FOO: "bar", GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
      },
      ANTIGRAVITY_GUEST.guarantees,
    );

    expect(plan.command).toMatch(/agy/);
    expect(plan.args).toContain("--add-dir");
    expect(plan.args).toContain("/repos/app");
    expect(plan.cwd).toBeTruthy();
    expect(plan.tmpDirs).toEqual([]);
    expect(plan.guarantees.capture).toBe("post-hoc");
    expect(plan.guarantees.identity).toBe("mcp-url");
    expect(plan.env.HOME).toBe(plan.cwd);
    expect(plan.env.GEMINI_API_KEY).toBe("test-gemini-key");
  });

  it("keeps agy's background updater off whatever the session env says", () => {
    const plan = planAntigravityLaunch(
      { sessionId: "sess-pin", cwd: "/repos/app", env: { GEMINI_API_KEY: "test-gemini-key", AGY_CLI_DISABLE_AUTO_UPDATE: "false" }, mcpServers: {} },
      ANTIGRAVITY_GUEST.guarantees,
    );
    expect(plan.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });

  it("passes model and resume parameters", () => {
    const plan = planAntigravityLaunch(
      {
        sessionId: "sess-2",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        model: "google/gemini-3.8-flash-high",
        resume: { harnessSessionId: "prior-chat-id" },
        mcpServers: {},
      },
      ANTIGRAVITY_GUEST.guarantees,
    );

    expect(plan.args).toContain("--model");
    expect(plan.args).toContain("gemini-3.8-flash-high");
    expect(plan.args).toContain("--conversation");
    expect(plan.args).toContain("prior-chat-id");
    expect(plan.harnessSessionId).toBe("prior-chat-id");
  });

  it("refuses one-shot prompt in guest mode", () => {
    expect(() =>
      planAntigravityLaunch(
        {
          sessionId: "sess-3",
          cwd: "/repos/app",
          env: { GEMINI_API_KEY: "test-gemini-key" },
          mcpServers: {},
          options: { prompt: "tell me a joke" },
        },
        ANTIGRAVITY_GUEST.guarantees,
      ),
    ).toThrow(NotSupportedInMode);
  });

  it("refuses launch when GEMINI_API_KEY is missing", () => {
    expect(() =>
      planAntigravityLaunch(
        {
          sessionId: "sess-4",
          cwd: "/repos/app",
          env: {},
          mcpServers: {},
        },
        ANTIGRAVITY_GUEST.guarantees,
      ),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it("refuses resume without exact harnessSessionId", () => {
    expect(() =>
      planAntigravityLaunch(
        {
          sessionId: "sess-5",
          cwd: "/repos/app",
          env: { GEMINI_API_KEY: "test-gemini-key" },
          resume: { last: true },
          mcpServers: {},
        },
        ANTIGRAVITY_GUEST.guarantees,
      ),
    ).toThrow(/exact harness session ID/);
  });

  it("configures tracking relay hook when relayCommand is provided", () => {
    const plan = planAntigravityLaunch(
      {
        sessionId: "sess-6",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
        options: { relayCommand: "barry hook antigravity 123" },
      },
      ANTIGRAVITY_GUEST.guarantees,
    );

    const hooksFile = join(plan.cwd!, ".agents", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(hooks["barry-tracking"]).toBeDefined();
    expect(hooks["barry-tracking"].PreInvocation[0].command).toBe("barry hook antigravity 123");
  });

  it("discovers conversation id from brain directory", async () => {
    const plan = planAntigravityLaunch(
      {
        sessionId: "sess-7",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
      },
      ANTIGRAVITY_GUEST.guarantees,
    );

    expect(plan.discoverHarnessSessionId).toBeDefined();
    const before = await plan.discoverHarnessSessionId!();
    expect(before).toBeUndefined();

    const brainDir = join(plan.cwd!, ".gemini", "antigravity-cli", "brain", "11111111-2222-3333-4444-555555555555");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, "metadata.json"), "{}");

    const after = await plan.discoverHarnessSessionId!();
    expect(after).toBe("11111111-2222-3333-4444-555555555555");
  });
});

it("discovers exactly one conversation created after the snapshot", () => {
  const plan = planAntigravityLaunch({ sessionId: "discovery", cwd: "/tmp", env: { GEMINI_API_KEY: "test" }, mcpServers: {} }, ANTIGRAVITY_GUEST.guarantees);
  const brain = join(plan.cwd!, ".gemini", "antigravity-cli", "brain");
  const old = "11111111-2222-3333-4444-555555555555", fresh = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  mkdirSync(join(brain, old), { recursive: true });
  expect(discoverAntigravityConversationId(plan.cwd!, [old])).toBeUndefined();
  mkdirSync(join(brain, fresh), { recursive: true });
  expect(discoverAntigravityConversationId(plan.cwd!, [old])).toBe(fresh);
  mkdirSync(join(brain, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"), { recursive: true });
  expect(discoverAntigravityConversationId(plan.cwd!, [old])).toBeUndefined();
});
