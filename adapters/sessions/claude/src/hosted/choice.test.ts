/**
 * Which hosted claude a session gets. Live — steerable, gated per call — on a
 * stated ANTHROPIC_API_KEY; a refusal without one. The subscription opt-in and
 * vendor-login tiers are gone: both authenticated outside the identity's
 * declared sources.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Session, SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";

const hosted = adapter.modes.hosted;
if (!hosted) throw new Error("claude declares no hosted mode");

const opened: Session[] = [];
afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
});

function config(env: Record<string, string>, extra: Partial<SessionConfig> = {}): SessionConfig {
  return { sessionId: "sess-choice", cwd: "/tmp", env: { PATH: "/usr/bin", ...env }, mcpServers: {}, ...extra };
}

const noEngine = () => Promise.reject(new Error("claude runs no engine"));

async function start(env: Record<string, string>, extra: Partial<SessionConfig> = {}): Promise<Session> {
  const session = await hosted!.start(config(env, extra), noEngine);
  opened.push(session);
  return session;
}

describe("the hosted claude a session gets", () => {
  it("is live on an API key: it steers and puts each call to Barry", async () => {
    const session = await start({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(session.guarantees).toMatchObject({ steer: true, gating: "per-call" });
  });

  it("refuses without a stated key", async () => {
    await expect(start({})).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("runs per turn for a one-turn session, on a key", async () => {
    const session = await start({ ANTHROPIC_API_KEY: "sk-ant-test" }, { ephemeral: true });
    expect(session.guarantees).toMatchObject({ steer: false, gating: "per-call" });
  });

  it("adopts a conversation Barry did not start, on either path", async () => {
    const adopt = hosted.adopt;
    if (!adopt) throw new Error("claude hosted declares no adopt");
    const live = await adopt("conv-from-the-tui", config({ ANTHROPIC_API_KEY: "sk-ant-test" }));
    const perTurn = await adopt("conv-from-the-tui", config({ ANTHROPIC_API_KEY: "sk-ant-test" }, { ephemeral: true }));
    opened.push(live, perTurn);
    expect([live.harnessSessionId, perTurn.harnessSessionId]).toEqual(["conv-from-the-tui", "conv-from-the-tui"]);
    expect(() => adopt("", config({}))).toThrow(/conversation id/);
  });
});
