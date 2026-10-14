import { describe, expect, it } from "vitest";
import {
  CredentialRequired,
  FORBIDDEN_CREDENTIAL_ENV,
  declaredKeyFor,
  envCredentialStore,
  providerKeyEnv,
  requireDeclaredKey,
} from "./credentials.js";

describe("Pi Credentials", () => {
  it("resolves declared keys from environment", () => {
    expect(declaredKeyFor("anthropic", { ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("sk-ant-test");
    expect(declaredKeyFor("openai", { OPENAI_API_KEY: "sk-proj-test" })).toBe("sk-proj-test");
    expect(declaredKeyFor("google", { GEMINI_API_KEY: "gem-test" })).toBe("gem-test");
    expect(declaredKeyFor("anthropic", {})).toBeUndefined();
  });

  it("names the required env var in refusal message", () => {
    expect(() =>
      requireDeclaredKey({ provider: "anthropic", model: "claude-sonnet-5" }, {}),
    ).toThrow(CredentialRequired);

    try {
      requireDeclaredKey({ provider: "anthropic", model: "claude-sonnet-5" }, {});
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      expect(e.message).toContain("ANTHROPIC_API_KEY");
      expect(e.message).toContain("anthropic/claude-sonnet-5");
    }
  });

  it("succeeds when the required key is declared", () => {
    expect(() =>
      requireDeclaredKey(
        { provider: "anthropic", model: "claude-sonnet-5" },
        { ANTHROPIC_API_KEY: "sk-ant-test" },
      ),
    ).not.toThrow();
  });

  it("builds an in-memory CredentialStore that only reads declared environment", async () => {
    const store = envCredentialStore({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-oa-test",
    });

    const anthropicCred = await store.read("anthropic");
    expect(anthropicCred).toEqual({ type: "api_key", key: "sk-ant-test" });

    const googleCred = await store.read("google");
    expect(googleCred).toBeUndefined();

    const list = await store.list();
    expect(list.some((item) => item.providerId === "anthropic")).toBe(true);
    expect(list.some((item) => item.providerId === "openai")).toBe(true);
    expect(list.some((item) => item.providerId === "google")).toBe(false);

    await expect(store.modify("anthropic", async () => ({ type: "api_key" as const, key: "unused" }))).rejects.toThrow(
      "never writes a credential",
    );
    await expect(store.delete("anthropic")).rejects.toThrow("never deletes a credential");
  });

  it("forbids PI_CODING_AGENT_DIR redirection", () => {
    expect(FORBIDDEN_CREDENTIAL_ENV).toContain("PI_CODING_AGENT_DIR");
  });

  it("returns known provider env keys", () => {
    expect(providerKeyEnv("anthropic")).toContain("ANTHROPIC_API_KEY");
    expect(providerKeyEnv("unknown-vendor")).toEqual([]);
  });
});
