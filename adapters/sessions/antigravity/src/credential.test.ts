import { describe, expect, it, vi } from "vitest";
import adapter from "./adapter.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityAuth, requireIdentityKey } from "./credential.js";

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


describe("an antigravity session on the Google account agy is signed into", () => {
  it("is an explicit opt-in on the identity", () => {
    expect(antigravityAuth({})).toBe("api-key");
    expect(antigravityAuth({ GEMINI_API_KEY: "k" })).toBe("api-key");
    expect(antigravityAuth({ ANTIGRAVITY_AUTH: "google-account" })).toBe("google-account");
    expect(antigravityAuth({ ANTIGRAVITY_AUTH: "anything-else" })).toBe("api-key");
  });

  it("falls back to the host process env, then the instance env file", () => {
    const none = () => undefined;
    expect(antigravityAuth({}, { ANTIGRAVITY_AUTH: "google-account" }, none)).toBe("google-account");
    expect(antigravityAuth({ ANTIGRAVITY_AUTH: "api-key" }, { ANTIGRAVITY_AUTH: "google-account" }, none)).toBe("api-key");
    expect(antigravityAuth({}, {}, key => (key === "ANTIGRAVITY_AUTH" ? "google-account" : undefined))).toBe("google-account");
    expect(antigravityAuth({}, {}, none)).toBe("api-key");
  });

  it("needs no key, but does need the Mac's cached sign-in", () => {
    const signIn = join(mkdtempSync(join(tmpdir(), "agy-signin-")), "antigravity-oauth-token");
    expect(() => requireIdentityKey({ ANTIGRAVITY_AUTH: "google-account" }, signIn)).toThrow(/not signed in/);
    writeFileSync(signIn, "token");
    expect(() => requireIdentityKey({ ANTIGRAVITY_AUTH: "google-account" }, signIn)).not.toThrow();
  });
});
