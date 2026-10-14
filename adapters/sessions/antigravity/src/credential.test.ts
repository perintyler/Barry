import { describe, expect, it, vi } from "vitest";
import adapter from "./adapter.js";
import { requireIdentityKey } from "./credential.js";

describe("an antigravity session without the identity's key", () => {
  it("requireIdentityKey throws when GEMINI_API_KEY is missing", () => {
    expect(() => requireIdentityKey({})).toThrow(/GEMINI_API_KEY/);
    expect(() => requireIdentityKey({ GEMINI_API_KEY: "present" })).not.toThrow();
  });

  it("is refused before hosted session starts", async () => {
    const startEngine = vi.fn();
    await expect(
      adapter.modes.hosted!.start(
        {
          sessionId: "s",
          cwd: "/repo",
          env: { PATH: "/bin" },
          mcpServers: {},
        },
        startEngine,
      ),
    ).rejects.toThrow(/GEMINI_API_KEY/);
    expect(startEngine).not.toHaveBeenCalled();
  });
});

