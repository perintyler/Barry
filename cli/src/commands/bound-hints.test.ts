import { afterEach, expect, it, vi } from "vitest";
import { CLI_TARGET } from "../target.js";
import { defaultPrintResumeHint } from "../ui/dispatch.js";
import { completionCommand } from "./completion.js";

const globals = globalThis as Record<symbol, unknown>;
const previous = globals[CLI_TARGET];
afterEach(() => { globals[CLI_TARGET] = previous; vi.restoreAllMocks(); });
it("identity resume hints name the identity command", () => {
  globals[CLI_TARGET] = { kind: "identity", name: "bonanza", binding: { id: 42, home: null } };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  defaultPrintResumeHint("session123");
  expect(log).toHaveBeenCalledWith("  bonanza session resume session123");
});
it("identity shell completion calls and registers the identity executable", () => {
  globals[CLI_TARGET] = { kind: "identity", name: "bonanza", binding: { id: 42, home: null } };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  completionCommand();
  const script = log.mock.calls[0][0] as string;
  expect(script).toContain("compdef _bonanza bonanza");
  expect(script).toContain("complete -F _bonanza bonanza");
  expect(script).toContain("$(bonanza __complete");
  expect(script).not.toContain("$(barry __complete");
});
