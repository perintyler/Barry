import { describe, expect, it, vi } from "vitest";
import adapter from "./adapter.js";

describe("a codex session without the identity's key", () => {
  // Otherwise the engine would authenticate with whatever key it inherited.
  it("is refused before any engine starts", async () => {
    const startEngine = vi.fn();
    await expect(
      adapter.modes.hosted!.start({ sessionId: "s", cwd: "/repo", env: { PATH: "/bin" }, mcpServers: {} }, startEngine),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(startEngine).not.toHaveBeenCalled();
  });
});
