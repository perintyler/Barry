import { describe, it, expect } from "vitest";
import { buildSandboxSettings } from "./sdk-sandbox.js";

describe("buildSandboxSettings", () => {
  it("returns undefined when the bound does not ask for a sandbox", () => {
    expect(buildSandboxSettings(undefined)).toBeUndefined();
    expect(buildSandboxSettings({})).toBeUndefined();
    expect(buildSandboxSettings({ enforce: "guard" })).toBeUndefined();
    expect(buildSandboxSettings({ enforce: "guard", allow: ["a.com"] })).toBeUndefined();
  });

  it("ALWAYS disables unsandboxed commands", () => {
    // The single most important assertion in this file. Left at the SDK
    // default, an agent that hits a blocked host retries with
    // `dangerouslyDisableSandbox` and succeeds — verified live. If this ever
    // becomes configurable, the sandbox tier is decorative.
    for (const bound of [
      { enforce: "sandbox" as const },
      { enforce: "sandbox" as const, allow: [] },
      { enforce: "sandbox" as const, allow: ["a.com"], deny: ["*"] },
    ]) {
      expect(buildSandboxSettings(bound)?.allowUnsandboxedCommands).toBe(false);
      // A sandbox that cannot start fails the run rather than running unsandboxed.
      expect(buildSandboxSettings(bound)?.failIfUnavailable).toBe(true);
    }
  });

  it("defaults to an empty allowlist — deny all egress but localhost", () => {
    const s = buildSandboxSettings({ enforce: "sandbox" });
    expect(s?.network?.allowedDomains).toEqual([]);
  });

  it("passes the allowlist through and extracts hostnames from URL globs", () => {
    const s = buildSandboxSettings({
      enforce: "sandbox",
      allow: ["api.anthropic.com", "https://github.com/org/*", "*.internal.co:8443/v1/*"],
    });
    expect(s?.network?.allowedDomains).toEqual(["api.anthropic.com", "github.com", "*.internal.co"]);
  });

  it("ignores the deny-list — it is a separate, guard-layer concern", () => {
    // `deny` and `allow` are not convertible; a deny-list must never
    // be silently reinterpreted as what the sandbox permits.
    const s = buildSandboxSettings({
      enforce: "sandbox",
      deny: ["*.internal.co"],
    });
    expect(s?.network?.allowedDomains).toEqual([]);
  });

  it("enables the sandbox and auto-allows bash", () => {
    const s = buildSandboxSettings({ enforce: "sandbox" });
    expect(s?.enabled).toBe(true);
    expect(s?.autoAllowBashIfSandboxed).toBe(true);
    expect(s?.network?.allowLocalBinding).toBe(true);
  });

  it("carries unix sockets only when provided", () => {
    expect(buildSandboxSettings({ enforce: "sandbox" })?.network?.allowUnixSockets)
      .toBeUndefined();
    expect(
      buildSandboxSettings({ enforce: "sandbox" }, { allowUnixSockets: ["/tmp/mcp.sock"] })
        ?.network?.allowUnixSockets,
    ).toEqual(["/tmp/mcp.sock"]);
  });
});
