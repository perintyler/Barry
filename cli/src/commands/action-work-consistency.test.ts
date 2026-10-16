import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { CLI_TARGET } from "../target.js";
import {
  actionWorkLookupCommand,
  actionWorkResultCommand,
  actionWorkShowCommand,
  actionWorkStartCommand,
  actionWorkStopCommand,
  actionWorkWaitCommand,
  isUnconfirmedIdentityAdmission,
  isUnconfirmedIdentityStop,
  registerActionWork,
} from "./action-work.js";

describe("identity action-work CLI consistency and error classification (P5.6 / P5.7)", () => {
  it("classifies local validation and server pre-acceptance refusals separately from unconfirmed submissions", () => {
    expect(isUnconfirmedIdentityAdmission(new Error("local parse error"), false)).toBe(false);
    expect(
      isUnconfirmedIdentityAdmission(
        { code: "invalid_request", status: null, message: "Invalid input" },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityAdmission(
        { code: "credential_error", status: null, message: "Missing token" },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityAdmission(
        {
          code: "RestoreAdmissionPaused",
          status: 409,
          detail: { admission_disposition: "not-accepted", error: "RestoreAdmissionPaused" },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityAdmission(
        {
          code: "WorkAdmissionDenied",
          status: 403,
          detail: { admission_disposition: "refused", error: "WorkAdmissionDenied" },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityAdmission(
        {
          code: "WorkAdmissionUnknown",
          status: 503,
          detail: { error: "WorkAdmissionUnknown", retryable: true },
        },
        true,
      ),
    ).toBe(true);
    expect(
      isUnconfirmedIdentityAdmission(
        { code: "timeout", status: null, message: "Request timed out" },
        true,
      ),
    ).toBe(true);
  });

  it("classifies stale-revision and pre-mutation Stop refusals separately from unconfirmed Stop replies", () => {
    expect(isUnconfirmedIdentityStop(new Error("local error"), false)).toBe(false);
    expect(
      isUnconfirmedIdentityStop(
        {
          code: "WorkRevisionConflict",
          status: 409,
          detail: { error: "WorkRevisionConflict", stop_disposition: "refused" },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityStop(
        {
          code: "Forbidden",
          status: 403,
          detail: { error: "Forbidden", stop_disposition: "refused" },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isUnconfirmedIdentityStop(
        {
          code: "WorkStopUnknown",
          status: 503,
          detail: { error: "WorkStopUnknown", retryable: true },
        },
        true,
      ),
    ).toBe(true);
  });

  it("registers canonical work-show, work-result, work-stop, and work-wait subcommands", () => {
    const action = new Command("action");
    registerActionWork(action);
    const names = action.commands.map(cmd => cmd.name());
    expect(names).toEqual(["work-show", "work-result", "work-stop", "work-wait"]);
  });

  it("rejects operator target or invalid inputs before emitting unconfirmed admission or stop warnings", async () => {
    const previousTarget = Reflect.get(globalThis, CLI_TARGET);
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    Reflect.set(globalThis, CLI_TARGET, { kind: "system" });
    try {
      process.exitCode = 0;
      await actionWorkStartCommand("demo:echo", {
        session: "sess-1",
        inputJson: '{"msg":"hello"}',
        key: "key-local-fail",
      });
      expect(process.exitCode).toBe(1);
      const stderrText = errorSpy.mock.calls.map(args => String(args[0])).join("\n");
      expect(stderrText).toContain("Use an identity CLI with an explicit selected session");
      expect(stderrText).not.toContain("Admission is unconfirmed");

      errorSpy.mockClear();
      process.exitCode = 0;
      await actionWorkLookupCommand("key-local-fail", { session: "sess-1" });
      expect(process.exitCode).toBe(1);

      errorSpy.mockClear();
      process.exitCode = 0;
      await actionWorkShowCommand("work_0123456789abcdef0123456789abcdef", { session: "sess-1" });
      expect(process.exitCode).toBe(1);

      errorSpy.mockClear();
      process.exitCode = 0;
      await actionWorkResultCommand("work_0123456789abcdef0123456789abcdef", { session: "sess-1" });
      expect(process.exitCode).toBe(1);

      errorSpy.mockClear();
      process.exitCode = 0;
      await actionWorkStopCommand("work_0123456789abcdef0123456789abcdef", {
        session: "sess-1",
        revision: "2",
        reason: "No longer needed",
      });
      expect(process.exitCode).toBe(1);
      const stopStderr = errorSpy.mock.calls.map(args => String(args[0])).join("\n");
      expect(stopStderr).not.toContain("Stop is unconfirmed");

      errorSpy.mockClear();
      process.exitCode = 0;
      await actionWorkWaitCommand("work_0123456789abcdef0123456789abcdef", {
        session: "sess-1",
        timeoutMs: 100,
        pollMs: 25,
      });
      expect(process.exitCode).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      Reflect.set(globalThis, CLI_TARGET, previousTarget);
      process.exitCode = previousExitCode;
    }
  });
});
