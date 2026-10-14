/**
 * What claude is handed: the options its SDK queries are built with, and the
 * `claude` launch — for its own models, for a model another vendor serves
 * through the endpoint a composition root resolved, and for the denials and
 * defaults every session carries.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import adapter from "./adapter.js";
import { buildSdkOptions, runOneShot } from "./anthropic-compatible/sdk-impl.js";
import { KEY_HELPER_COMMAND, KEY_HELPER_ENV, COMPETING_CREDENTIAL_ENV, planClaudeLaunch } from "./anthropic-compatible/launch.js";
import { CredentialRequired } from "./credential.js";
import { NATIVE_TOOLS } from "./native-tools.js";

const GUEST = adapter.modes.guest!.guarantees;
const OK_RESULT = [{ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }];

function streamOf(messages: unknown[]): { read: number } {
  const progress = { read: 0 };
  mockQuery.mockReturnValue({
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (progress.read < messages.length) return { value: messages[progress.read++] as SDKMessage, done: false as const };
        return { value: undefined, done: true as const };
      },
    }),
  });
  return progress;
}

async function collect(iter: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { sessionId: "s", cwd: "/tmp", env: { PATH: "/bin", HOME: "/home" }, mcpServers: {}, ...overrides };
}

type SdkOptions = ReturnType<typeof buildSdkOptions>;

/** The options one query was built with. */
async function optionsFor(overrides: Partial<SessionConfig>): Promise<SdkOptions> {
  streamOf(OK_RESULT);
  await collect(runOneShot(session(overrides), "test", undefined, new AbortController().signal));
  return (mockQuery.mock.calls.at(-1)![0] as { options: SdkOptions }).options;
}

beforeEach(() => vi.clearAllMocks());

describe("the SDK options, for claude's own models", () => {
  it("leave the address and key alone, so the user's own key or login is used", async () => {
    const options = await optionsFor({ model: "anthropic/claude-opus-5" });
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.model).toBe("claude-opus-5");
    expect((await optionsFor({})).env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("pin adaptive thinking", async () => {
    expect((await optionsFor({ model: "anthropic/claude-opus-5" })).thinking).toEqual({ type: "adaptive" });
  });
});

describe("the SDK options, for a model another vendor serves", () => {
  const zai: Partial<SessionConfig> = { model: "zai/glm-5.2", endpoint: { baseUrl: "https://api.z.ai/api/anthropic", apiKey: "zk" } };
  const ollama: Partial<SessionConfig> = { model: "ollama/qwen3:4b", endpoint: { baseUrl: "http://127.0.0.1:11434", apiKey: "ollama-local" } };

  it("point claude at the endpoint it was handed, with its key and the model's own id", async () => {
    const options = await optionsFor(zai);
    expect(options.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_API_KEY: "zk" });
    expect(options.model).toBe("glm-5.2");
  });

  // THE CREDENTIAL-LEAK GUARD: pointed at a local daemon, a real Anthropic
  // key in the env must not ride along — the placeholder replaces it.
  it("never forward a real Anthropic key to a local daemon", async () => {
    const options = await optionsFor({ ...ollama, env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-real-key" } });
    expect(options.env.ANTHROPIC_API_KEY).toBe("ollama-local");
  });

  it("do not pin thinking, which those backends are not known to accept", async () => {
    expect((await optionsFor(zai)).thinking).toBeUndefined();
    expect((await optionsFor(ollama)).thinking).toBeUndefined();
  });
});

describe("a model another vendor serves, without what it needs", () => {
  const hosted = adapter.modes.hosted!;
  const noEngine = () => Promise.reject(new Error("no engine"));

  it("is refused without an endpoint, rather than sent to Anthropic under a foreign name", async () => {
    await expect(hosted.start(session({ model: "zai/glm-5.2" }), noEngine)).rejects.toThrow(/needs an endpoint/);
    await expect(adapter.modes.guest!.plan(session({ model: "zai/glm-5.2" }))).rejects.toThrow(/needs an endpoint/);
  });

  it("is refused without a key, rather than sending the user's own login to that vendor", async () => {
    const keyless = session({ model: "zai/glm-5.2", endpoint: { baseUrl: "https://api.z.ai/api/anthropic" } });
    await expect(hosted.start(keyless, noEngine)).rejects.toThrow(/without its key/);
    await expect(adapter.modes.guest!.plan(keyless)).rejects.toThrow(/without its key/);
  });
});

describe("a hosted session's warnings", () => {
  const hosted = adapter.modes.hosted!;
  const noEngine = () => Promise.reject(new Error("no engine"));
  // Every hosted session states its credential now; these tests are about
  // tool warnings, so the key is fixture, not subject.
  const keyedEnv = { PATH: "/bin", HOME: "/home", ANTHROPIC_API_KEY: "sk-ant-test" };

  it("apply the complete native ceiling without requiring callers to supply it", async () => {
    const started = await hosted.start(session({ env: keyedEnv, deniedTools: ["Write", "Edit", "AskUserQuestion"] }), noEngine);
    expect(started.warnings).toBeUndefined();
    await started.close();
  });

  it("are absent for a fully-scoped session", async () => {
    const everything = ["Write", "Edit", "AskUserQuestion", "Bash", "WebFetch", "WebSearch", "Read", "Glob", "Grep", "SendMessage", "Task", "TaskOutput", "TaskStop"];
    const started = await hosted.start(session({ env: keyedEnv, deniedTools: everything }), noEngine);
    expect(started.warnings).toBeUndefined();
    await started.close();
  });
});

describe("the SDK options every session carries", () => {
  it("name the user whose login the CLI reads, unless the session already does", async () => {
    // session() hands PATH and HOME only, as a bag's one-off run does.
    expect((await optionsFor({})).env.USER).toBe(userInfo().username);
    expect((await optionsFor({ env: { PATH: "/bin", HOME: "/home", USER: "someone" } })).env.USER).toBe("someone");
  });


  it("deny the baseline, then the caller's list, which can only widen it", async () => {
    expect((await optionsFor({ deniedTools: ["Bash"] })).disallowedTools).toEqual([...NATIVE_TOOLS]);
    expect((await optionsFor({})).disallowedTools).toEqual([...NATIVE_TOOLS]);
  });

  it("silence the nonessential features, unless the session turned one back on", async () => {
    const options = await optionsFor({});
    expect(options.env).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    });
    const overridden = await optionsFor({ env: { PATH: "/bin", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" } });
    expect(overridden.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("true");
    expect(options.promptSuggestions).toBe(false);
    expect(options.agentProgressSummaries).toBe(false);
  });
});

describe("the events a run reports", () => {
  it("stamp subagent output with the call that spawned it, and carry cache tokens", async () => {
    streamOf([
      { type: "assistant", parent_tool_use_id: "toolu_parent", message: { content: [{ type: "text", text: "from a subagent" }] } },
      { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
    ]);
    const events = await collect(runOneShot(session(), "x", undefined, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "text", parentToolUseId: "toolu_parent" });
    expect(events.find((event) => event.type === "done")).toMatchObject({ usage: { cacheReadTokens: 900, cacheWriteTokens: 100 } });
  });
});

/**
 * A failed API call surfaces as an assistant message carrying `error`. With an
 * output schema the SDK re-prompts after each one, so a run whose every request
 * is rejected loops until something outside it gives up.
 */
describe("a one-shot run that keeps failing at the API", () => {
  const apiError = (error: string) => ({ type: "assistant", error, message: { content: [{ type: "text", text: `API Error: 400 ${error}` }] } });
  const reply = { type: "assistant", message: { content: [{ type: "text", text: "12" }] } };

  async function run(messages: unknown[]) {
    const progress = streamOf(messages);
    const events = await collect(runOneShot(session(), "sum", { type: "object" }, new AbortController().signal));
    const aborted = (mockQuery.mock.calls.at(-1)![0] as { options: { abortController: AbortController } }).options.abortController.signal.aborted;
    return { events, read: progress.read, aborted };
  }

  it("stops at the first error no retry can fix", async () => {
    const messages: unknown[] = [...Array(10)].map(() => apiError("invalid_request"));
    const { events, read, aborted } = await run(messages.concat(OK_RESULT));
    expect(read).toBe(1);
    expect(aborted).toBe(true);
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", error: "API error (invalid_request): API Error: 400 invalid_request" }]);
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("stops after three failed turns in a row of any other kind", async () => {
    const { events, read, aborted } = await run([...Array(10)].map(() => apiError("unknown")));
    expect(read).toBe(3);
    expect(aborted).toBe(true);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("lets a run recover from a transient error", async () => {
    const { events, aborted } = await run([apiError("rate_limit"), apiError("rate_limit"), reply, apiError("rate_limit"), ...OK_RESULT]);
    expect(aborted).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "result")).toBe(true);
  });
});

describe("the claude launch", () => {
  // A cwd that does not exist, so planning leaves the real ~/.claude.json alone.
  const keyed = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-identity" };
  const base = session({ cwd: "/repo", env: keyed, options: { mcpConfigPath: "/tmp/mcp.json" } });

  /** The settings file a plan points claude at. */
  function settingsOf(plan: { args: string[] }): Record<string, unknown> {
    return JSON.parse(readFileSync(plan.args[plan.args.indexOf("--settings") + 1], "utf8")) as Record<string, unknown>;
  }

  it("is refused without the identity's key, rather than running on the user's own login", async () => {
    await expect(planClaudeLaunch({ ...base, env: { PATH: "/usr/bin" } }, GUEST)).rejects.toThrow(CredentialRequired);
    await expect(adapter.modes.guest!.plan({ ...base, env: { PATH: "/usr/bin" } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(adapter.modes.instrumented!.plan({ ...base, env: { PATH: "/usr/bin" } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("hands the key to the TUI through the key helper only, removing every competing credential", async () => {
    const shell = Object.fromEntries(COMPETING_CREDENTIAL_ENV.map((name) => [name, `from-the-shell-${name}`]));
    const plan = await planClaudeLaunch({ ...base, env: { ...shell, ...keyed } }, GUEST);
    expect(plan.env[KEY_HELPER_ENV]).toBe("sk-ant-identity");
    for (const name of COMPETING_CREDENTIAL_ENV) expect(plan.env[name]).toBeUndefined();
    expect(settingsOf(plan).apiKeyHelper).toBe(KEY_HELPER_COMMAND);
  });

  it("adds the helper to the caller's settings rather than replacing them", async () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), "cc-settings-")), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ["Bash(*)"] }, apiKeyHelper: "echo someone-else" }));
    const plan = await planClaudeLaunch({ ...base, options: { mcpConfigPath: "/tmp/mcp.json", settingsPath } }, GUEST);
    expect(plan.args[plan.args.indexOf("--settings") + 1]).toBe(settingsPath);
    expect(settingsOf(plan)).toEqual({ hooks: { Stop: [] }, permissions: { deny: [...new Set(["Bash(*)", ...NATIVE_TOOLS.map(tool => `${tool}(*)`)])] }, apiKeyHelper: KEY_HELPER_COMMAND });
    expect(plan.tmpDirs).toEqual([]);
  });

  it("points a routed model at the endpoint it was handed, with that endpoint's key and the model's own id", async () => {
    const plan = await planClaudeLaunch(
      { ...base, model: "ollama/my-custom:7b", endpoint: { baseUrl: "http://10.0.0.7:11434", apiKey: "ollama-local" } },
      GUEST,
    );
    expect(plan.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://10.0.0.7:11434", [KEY_HELPER_ENV]: "ollama-local" });
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.args).toContain("my-custom:7b");
  });

  it("leaves the address alone for claude's own model", async () => {
    const plan = await planClaudeLaunch({ ...base, model: "anthropic/claude-opus-5" }, GUEST);
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plan.args).toContain("claude-opus-5");
  });

  it("reserves the conversation id before the TUI starts, and resumes only the exact one", async () => {
    const fresh = await planClaudeLaunch(base, GUEST);
    expect(fresh.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.args.slice(fresh.args.indexOf("--session-id"), fresh.args.indexOf("--session-id") + 2)).toEqual(["--session-id", fresh.harnessSessionId]);

    const resumed = await planClaudeLaunch({ ...base, resume: { harnessSessionId: "conv-1" } }, GUEST);
    expect(resumed.harnessSessionId).toBe("conv-1");
    expect(resumed.args).toContain("--resume");
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.args).not.toContain("--continue");
  });

  it("refuses what would widen Barry's policy, as every mode does", async () => {
    const planGuest = async (config: SessionConfig) => adapter.modes.guest!.plan(config);
    await expect(planGuest({ ...base, extraArgs: ["--tools", "Bash"] })).rejects.toThrow(/Raw adapter arguments/);
    await expect(planGuest({ ...base, resume: { last: true } })).rejects.toThrow(/exact recorded conversation/);
    await expect(planGuest({ ...base, strictMcpConfig: false })).rejects.toThrow(/unscoped/);
  });

  it("removes every native tool from the TUI's context", async () => {
    const plan = await adapter.modes.guest!.plan(base);
    const flagged = plan.args.flatMap((arg, i) => (arg === "--disallowed-tools" ? [plan.args[i + 1]] : []));
    expect(flagged).toEqual(expect.arrayContaining([...NATIVE_TOOLS]));
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.warnings.filter((w) => w.includes("barry equivalents"))).toHaveLength(0);
  });

  it("fills the silencing env without touching what the caller set", async () => {
    const plan = await planClaudeLaunch({ ...base, env: { ...keyed, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" } }, GUEST);
    expect(plan.env).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  it("emits --disallowed-tools for the baseline plus the caller's list", async () => {
    const plan = await planClaudeLaunch({ ...base, deniedTools: ["Read", "Glob", "Grep"] }, GUEST);
    const flagged = plan.args.flatMap((arg, i) => (arg === "--disallowed-tools" ? [plan.args[i + 1]] : []));
    expect(flagged).toEqual([...NATIVE_TOOLS]);
  });


});

it("switches on only allowed native reads in hosted options", async () => {
  const options = await optionsFor({ allowedNativeTools: ["Read", "Glob", "Grep"], deniedTools: ["Grep"] });
  expect(options.tools).toEqual(["Read", "Glob"]);
  expect(options.disallowedTools).toEqual(NATIVE_TOOLS.filter(tool => !["Read", "Glob"].includes(tool)));
});
it.each(["guest", "instrumented"] as const)("switches on only allowed native reads in %s", async mode => {
  const plan = await adapter.modes[mode]!.plan(session({ env: { ANTHROPIC_API_KEY: "fixture-key" }, allowedNativeTools: ["Read", "Glob", "Grep"], deniedTools: ["Grep"] }));
  expect(plan.args[plan.args.indexOf("--tools") + 1]).toBe("Read,Glob");
  const denied = plan.args.flatMap((arg, i) => arg === "--disallowed-tools" ? [plan.args[i + 1]] : []);
  expect(denied).not.toContain("Read");
  expect(denied).toContain("Grep");
  const settings = JSON.parse(readFileSync(plan.args[plan.args.indexOf("--settings") + 1], "utf8"));
  expect(settings.permissions.deny).toContain("Grep(*)");
  expect(settings.permissions.deny).not.toContain("Read(*)");
});
