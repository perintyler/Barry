import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_REQUIREMENTS, PIN_ENV, resolveAntigravityBin } from "./bin.js";

describe("Antigravity bin resolution and requirements", () => {
  it("resolves the agy binary path", () => {
    const bin = resolveAntigravityBin();
    expect(bin).toBeTruthy();
    expect(bin).toMatch(/agy/);
  });

  it("extracts version with versionPattern", () => {
    const pattern = new RegExp(ANTIGRAVITY_REQUIREMENTS.binary.versionPattern);
    const match = pattern.exec("agy 1.2.14");
    expect(match?.[1]).toBe("1.2.14");

    const match2 = pattern.exec("1.2.14\n");
    expect(match2?.[1]).toBe("1.2.14");
  });

  it("satisfies requirement invariants", () => {
    expect(ANTIGRAVITY_REQUIREMENTS.binary.command).toBe("agy");
    expect(ANTIGRAVITY_REQUIREMENTS.binary.versionArgs).toContain("--version");
    expect(ANTIGRAVITY_REQUIREMENTS.binary.recommendedVersion!).toBe("1.3.6");
    expect(ANTIGRAVITY_REQUIREMENTS.binary.install.darwin).toBeTruthy();
    expect((ANTIGRAVITY_REQUIREMENTS as { login?: unknown }).login).toBeUndefined();
  });

  it("prevents the running process from updating itself", () => {
    expect(PIN_ENV.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });
});
