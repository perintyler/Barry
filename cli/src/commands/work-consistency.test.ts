import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";
import {
  formatCliWorkItemHuman,
  formatCliWorkResultHuman,
  isRefusedOperatorStop,
   isRefusedOperatorSubmission,
  presentCliWorkItem,
  registerWork,
  startOperatorWork,
  waitForOperatorWork,
} from "./work.js";

describe("operator work CLI consistency and error classification (P5.7)", () => {
  beforeEach(() => {
    writeServiceRegistry({
      version: 2,
      generated: new Date().toISOString(),
      resources: {
        "workflows.runtime": {
          bag: "workflows",
          name: "runtime",
          kind: "service",
          url: "http://127.0.0.1:4199",
        },
      },
    });
  });

  it("distinguishes pre-acceptance refusal from ambiguous submission failure", async () => {
    const installation = installationRegistry().id;
    const key = {
      id: "cli-refusal-test",
      secret: "fixture-only-dedicated-refusal-operator-key",
      not_before: 0,
      not_after: Date.now() + 3600000,
    };
    const keys = join(process.env.BARRY_HOME!, "refusal-cli-keys.json");
    writeFileSync(keys, JSON.stringify({ "workflows.cli.operator": [key] }), { mode: 0o600 });
    const oldSecret = process.env.BARRY_SECRET;
    process.env.BARRY_SECRET = "refusal-fixture-secret";

    let mode: "refused" | "lost" = "refused";
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).endsWith("/api/metadata")) {
        return Response.json({ installation });
      }
      if (mode === "refused") {
        return Response.json(
          {
            code: "RestoreAdmissionPaused",
            error: "Restore admission is paused.",
            admission_disposition: "not-accepted",
            retryable: false,
          },
          { status: 409 },
        );
      }
      throw new Error("socket hang up after send");
    });

    try {
      let refusedMessage = "";
      try {
        await startOperatorWork(
          "echo",
          { inputJson: '{"message":"hi"}', key: "refused-key-1", delegationKeys: keys },
          () => {},
        );
      } catch (error) {
        refusedMessage = error instanceof Error ? error.message : String(error);
      }
      expect(refusedMessage).toContain("Submission was refused before acceptance");
      expect(refusedMessage).not.toContain("retry this same key");

      mode = "lost";
      await expect(
        startOperatorWork(
          "echo",
          { inputJson: '{"message":"hi"}', key: "ambiguous-key-1", delegationKeys: keys },
          () => {},
        ),
      ).rejects.toThrow(/Submission was not confirmed.*barry work lookup/i);
    } finally {
      vi.unstubAllGlobals();
      if (oldSecret === undefined) delete process.env.BARRY_SECRET;
      else process.env.BARRY_SECRET = oldSecret;
    }
  });

  it("distinguishes stale-revision Stop refusal from unconfirmed Stop reply", async () => {
    const oldSecret = process.env.BARRY_SECRET;
    process.env.BARRY_SECRET = "stop-fixture-secret";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    let mode: "stale" | "lost" = "stale";
    vi.stubGlobal("fetch", async () => {
      if (mode === "stale") {
        return Response.json(
          {
            code: "WorkRevisionConflict",
            error: "Expected revision 3 does not match current revision 4.",
            stop_disposition: "refused",
            retryable: false,
          },
          { status: 409 },
        );
      }
      throw new Error("network reset during stop");
    });

    try {
      const program = new Command().exitOverride();
      registerWork(program);
      const args = [
        "work",
        "stop",
        "work_abc123",
        "--revision",
        "3",
        "--request-id",
        "3b2e0475-2040-4085-8e3c-1ceda276883d",
      ];

      let staleErr = "";
      try {
        await program.parseAsync(args, { from: "user" });
      } catch (err) {
        staleErr = err instanceof Error ? err.message : String(err);
      }
      expect(staleErr).toContain("Stop refused because revision 3 is stale");
      expect(staleErr).toContain("barry work show work_abc123");
      expect(staleErr).not.toContain("Retry the same --revision");

      mode = "lost";
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
        /Stop reply was not confirmed\. Retry the same --revision and --request-id/,
      );
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      error.mockRestore();
      if (oldSecret === undefined) delete process.env.BARRY_SECRET;
      else process.env.BARRY_SECRET = oldSecret;
    }
  });

  it("supports work wait with --until-ceased and consistent human/JSON output", async () => {
    const oldSecret = process.env.BARRY_SECRET;
    process.env.BARRY_SECRET = "wait-fixture-secret";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          work_id: "work_wait1",
          workflow_id: "wf_wait1",
          title: "Deploy release",
          revision: 2,
          state: "stopping",
          facts: {
            coordinator: "running",
            phase: "executing",
            wait: "none",
            physical: "stopping",
            effect: "known",
            stop_requested: true,
            has_result: false,
          },
          allowed_actions: ["inspect"],
        });
      }
      return Response.json({
        work_id: "work_wait1",
        workflow_id: "wf_wait1",
        title: "Deploy release",
        revision: 3,
        state: "cancelled",
        facts: {
          coordinator: "cancelled",
          phase: "terminal",
          wait: "none",
          physical: "ceased",
          effect: "known",
          stop_requested: true,
          has_result: true,
        },
        allowed_actions: ["inspect", "result"],
      });
    });

    try {
      const settled = await waitForOperatorWork("work_wait1", {
        timeoutMs: 5000,
        pollMs: 25,
        untilCeased: true,
      });
      expect(settled.state).toBe("cancelled");
      expect(calls).toBe(2);

      const program = new Command().exitOverride();
      registerWork(program);
      await program.parseAsync(["work", "show", "work_wait1", "--human"], { from: "user" });
      const humanOut = String(log.mock.calls.at(-1)?.[0] ?? "");
      expect(humanOut).toContain("Deploy release (work_wait1)");
      expect(humanOut).toContain("State: Cancelled");
      expect(humanOut).toContain("Logical / Physical / Effect: cancelled / ceased / known");
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      if (oldSecret === undefined) delete process.env.BARRY_SECRET;
      else process.env.BARRY_SECRET = oldSecret;
    }
  });

  it("formats completed-with-checks-failed, stopping, and result notices consistently with web", () => {
    expect(isRefusedOperatorSubmission({ admissionDisposition: "not-accepted" }, true)).toBe(true);
    expect(isRefusedOperatorSubmission({ transportFailed: true }, true)).toBe(false);
    expect(isRefusedOperatorStop({ status: 409, code: "WorkRevisionConflict" })).toBe(true);
    expect(isRefusedOperatorStop({ status: 503, code: "WorkStopUnknown" })).toBe(false);

    const item = {
      work_id: "work_check",
      title: "Verify migration",
      revision: 5,
      state: "completed",
      facts: {
        coordinator: "completed",
        phase: "terminal",
        wait: "none",
        physical: "ceased",
        effect: "known",
        stop_requested: false,
        has_result: true,
      },
      allowed_actions: ["inspect"],
    };
    const result = {
      work_id: "work_check",
      status: "available",
      outcome: { ok: true, value: { migrated: 3 } },
      retained_output: {
        validation: "failed",
        validation_failures: ["checksum mismatch on shard 2"],
      },
    };
    const presented = presentCliWorkItem(item, result);
    expect(presented.badgeText).toBe("Completed · checks failed");
    expect(presented.validationState).toBe("failed");
    expect(presented.resultAccessNotice).toContain("current policy or session authority does not permit");

    const itemText = formatCliWorkItemHuman(item, result);
    expect(itemText).toContain("State: Completed · checks failed");
    expect(itemText).toContain("Validation failures: checksum mismatch on shard 2");

    const resultText = formatCliWorkResultHuman(result, item);
    expect(resultText).toContain("Outcome: Completed · checks failed");
    expect(resultText).toContain("Validation failures: checksum mismatch on shard 2");
  });
});
