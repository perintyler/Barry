import { describe, expect, it } from "vitest";
import { checkAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import adapter from "./adapter.js";
import { defaultCodexHome } from "./runtime.js";

const plan = async (options?: unknown) =>
  adapter.modes.instrumented!.plan({
    sessionId: "attach-1",
    cwd: "/repo",
    env: { PATH: "/usr/bin", HOME: "/home", OPENAI_API_KEY: "sk-identity" },
    mcpServers: {},
    ...(options ? { options } : {}),
  });

describe("the codex TUI attached to a hosted session", () => {
  it("is only launched for a hosted session that is already open", async () => {
    await expect(plan()).rejects.toThrow(/hosted session/);
  });

  it("resumes the hosted thread on the hosted engine, in the session's own home, holding no key", async () => {
    const launched = await plan({ attachment: { address: "/tmp/e/1.sock", harnessSessionId: "thread-1" } });
    expect(launched.args).toEqual(["resume", "thread-1", "--remote", "unix:///tmp/e/1.sock", "--cd", "/repo"]);
    expect(launched.env.CODEX_HOME).toBe(defaultCodexHome("attach-1"));
    expect(launched.env.OPENAI_API_KEY).toBeUndefined();
    expect(launched.harnessSessionId).toBe("thread-1");
  });

  it("declares no more than its hosted session gives", () => {
    expect(adapter.modes.instrumented?.attachesTo).toBe("hosted");
    const credentials = { TEST: { source: "vault" as const, item: "x", field: "password" as const } };
    expect(checkAdapter(adapter, { bagManifest: { credentials } }).problems).toEqual([]);
  });
});
