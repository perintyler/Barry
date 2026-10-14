import { afterEach, expect, it, vi } from "vitest";
import { CLI_SCOPE } from "../scope.js";
import { defaultPrintResumeHint } from "../ui/dispatch.js";
import { completionCommand } from "./completion.js";

const globals = globalThis as Record<symbol, unknown>;
const previous = globals[CLI_SCOPE];
afterEach(() => { globals[CLI_SCOPE] = previous; vi.restoreAllMocks(); });
it("identity resume hints name the identity command", () => {
  globals[CLI_SCOPE] = { kind: "identity", name: "bonanza", binding: { id: 42, home: null } };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  defaultPrintResumeHint("session123");
  expect(log).toHaveBeenCalledWith("  bonanza session resume session123");
});
it("identity shell completion calls and registers the identity executable", () => {
  globals[CLI_SCOPE] = { kind: "identity", name: "bonanza", binding: { id: 42, home: null } };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  completionCommand();
  const script = log.mock.calls[0][0] as string;
  expect(script).toContain("compdef _bonanza bonanza");
  expect(script).toContain("complete -F _bonanza bonanza");
  expect(script).toContain("$(bonanza __complete");
  expect(script).not.toContain("$(barry __complete");
});
