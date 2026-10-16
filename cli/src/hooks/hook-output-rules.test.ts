import { describe, expect, it } from "vitest";
import { enforceHookOutputRules } from "./hook-output-rules.js";

describe("enforceHookOutputRules (ADP-11)", () => {
  it("strips a Claude-shaped permission decision from a pre-tool hook", () => {
    const raw = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "bag says ok" },
    });
    const { output, strippedPermissionDecision } = enforceHookOutputRules("pre-tool", raw);
    expect(strippedPermissionDecision).toBe(true);
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecisionReason");
    // The rest of the hook's output survives.
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("strips a Cursor-shaped top-level permission from a pre-tool hook", () => {
    const { output, strippedPermissionDecision } = enforceHookOutputRules("pre-tool", JSON.stringify({ permission: "allow", note: "kept" }));
    expect(strippedPermissionDecision).toBe(true);
    const parsed = JSON.parse(output);
    expect(parsed).not.toHaveProperty("permission");
    expect(parsed.note).toBe("kept");
  });

  it("even strips a deny verdict: the gate is Barry's, not a bag's", () => {
    const { strippedPermissionDecision } = enforceHookOutputRules(
      "pre-tool",
      JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }),
    );
    expect(strippedPermissionDecision).toBe(true);
  });

  it("leaves a pre-tool hook with no verdict untouched", () => {
    const raw = JSON.stringify({ hookSpecificOutput: { additionalContext: "note" } });
    const { output, strippedPermissionDecision } = enforceHookOutputRules("pre-tool", raw);
    expect(strippedPermissionDecision).toBe(false);
    expect(output).toBe(raw);
  });

  it("never touches other events — a verdict there is meaningless to the gate", () => {
    const raw = JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } });
    for (const event of ["post-tool", "session-start", "session-end", "user-prompt", "stop"]) {
      const { output, strippedPermissionDecision } = enforceHookOutputRules(event, raw);
      expect(strippedPermissionDecision).toBe(false);
      expect(output).toBe(raw);
    }
  });

  it("passes the dispatcher's fail-open empty output through unchanged", () => {
    expect(enforceHookOutputRules("pre-tool", "{}\n")).toEqual({ output: "{}\n", strippedPermissionDecision: false });
    expect(enforceHookOutputRules("pre-tool", "")).toEqual({ output: "", strippedPermissionDecision: false });
  });

  it("leaves non-JSON stdout alone — it cannot carry a verdict the harness reads", () => {
    const raw = "some diagnostic line\n";
    expect(enforceHookOutputRules("pre-tool", raw)).toEqual({ output: raw, strippedPermissionDecision: false });
  });

  it("preserves a trailing newline when it strips a verdict", () => {
    const { output } = enforceHookOutputRules("pre-tool", `${JSON.stringify({ permission: "deny", keep: 1 })}\n`);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({ keep: 1 });
  });
});
