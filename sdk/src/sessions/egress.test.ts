import { describe, expect, it } from "vitest";
import { canEnforceInSandbox } from "./egress.js";

describe("canEnforceInSandbox", () => {
  it("covers total denials", () => {
    expect(canEnforceInSandbox(["all"])).toBe(true);
    expect(canEnforceInSandbox(["read", "write"])).toBe(true);
  });

  it("cannot express read-vs-write splits", () => {
    // The proxy filters by host, not HTTP method.
    expect(canEnforceInSandbox(["write"])).toBe(false);
    expect(canEnforceInSandbox(["read"])).toBe(false);
    expect(canEnforceInSandbox(["git:push"])).toBe(false);
  });

  it("treats a pure allowlist (no actions) as fully enforceable", () => {
    expect(canEnforceInSandbox(undefined)).toBe(true);
    expect(canEnforceInSandbox([])).toBe(true);
  });
});
