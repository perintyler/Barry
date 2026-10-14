import { describe, it, expect, vi, afterEach } from "vitest";
import { assertVaultAccessAllowedUnderTest } from "./test-guard.js";

/**
 * SDK-19: the test-only opt-out `BARRY_ALLOW_REAL_VAULT` must only take effect
 * under VITEST. A production shell with that variable set previously
 * short-circuited the whole guard — including the BARRY_HOME protection — so a
 * switch whose only purpose is steering the harness was reachable in
 * production.
 */
describe("assertVaultAccessAllowedUnderTest opt-out gating (SDK-19)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("honours BARRY_ALLOW_REAL_VAULT under VITEST (the round-trip suite)", () => {
    vi.stubEnv("VITEST", "1");
    vi.stubEnv("BARRY_ALLOW_REAL_VAULT", "1");
    vi.stubEnv("BARRY_HOME", "");
    expect(() => assertVaultAccessAllowedUnderTest("openVault", {})).not.toThrow();
  });

  it("ignores BARRY_ALLOW_REAL_VAULT outside VITEST, so the BARRY_HOME guard still fires", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("BARRY_ALLOW_REAL_VAULT", "1");
    vi.stubEnv("BARRY_HOME", "/tmp/some-instance");
    expect(() => assertVaultAccessAllowedUnderTest("openVault", {})).toThrow(/refuses to open the real vault/);
  });

  it("still lets an injected readSecret pointed at a stand-in through", () => {
    vi.stubEnv("VITEST", "1");
    vi.stubEnv("BARRY_ALLOW_REAL_VAULT", "");
    expect(() =>
      assertVaultAccessAllowedUnderTest("openVault", { serverUrl: "unix:///tmp/stand-in.sock", readSecret: () => "x" }),
    ).not.toThrow();
  });

  it("still refuses the real vault under VITEST without the opt-out", () => {
    vi.stubEnv("VITEST", "1");
    vi.stubEnv("BARRY_ALLOW_REAL_VAULT", "");
    expect(() => assertVaultAccessAllowedUnderTest("openVault", {})).toThrow(/under VITEST/);
  });
});
