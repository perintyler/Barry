// Verify delivery outcomes without sending real notifications from the test suite.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-075

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allDelivered, barryCli, notify, type NotifyResult } from "./notify.js";

async function withoutCli<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "barry-notify-"));
  const previous = process.env.BARRY_HOME;
  process.env.BARRY_HOME = home;
  mkdirSync(join(home, "empty"));
  mkdirSync(join(home, "app-support"));
  symlinkSync(join(home, "empty"), join(home, "app-support/current"));
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("allDelivered", () => {
  it("is true only when every ATTEMPTED channel succeeded", () => {
    expect(allDelivered({ slack: true, sms: true })).toBe(true);
    // sms:null means SMS was never requested — not a failure.
    expect(allDelivered({ slack: true, sms: null })).toBe(true);
  });

  it("does NOT read a partial delivery as success", () => {
    // The case that matters: Slack got through, the SMS that exists to wake
    // someone did not. Collapsing this to one boolean is how the old signature
    // lost the distinction.
    expect(allDelivered({ slack: true, sms: false })).toBe(false);
    expect(allDelivered({ slack: false, sms: true })).toBe(false);
    expect(allDelivered({ slack: false, sms: null })).toBe(false);
  });
});

describe("notify reports failure as failure", () => {
  it("returns per-channel false when there is no CLI to send with", async () => {
    // Negative control. If this path ever reports success, every downstream
    // delivery metric becomes a check that cannot fail.
    const r: NotifyResult = await withoutCli(() =>
      notify("must not send", { sms: true }),
    );
    expect(r.slack).toBe(false);
    expect(r.sms).toBe(false);
    expect(allDelivered(r)).toBe(false);
  });

  it("distinguishes 'SMS not requested' from 'SMS failed'", async () => {
    // Without sms:true the SMS channel is not attempted, so it is null —
    // absence, not failure. Conflating the two would inflate the failure count
    // with sends nobody asked for.
    const r = await withoutCli(() => notify("must not send", {}));
    expect(r.sms).toBeNull();
    expect(r.slack).toBe(false);
  });

  it("reports both channels delivered in dry-run without shelling out", async () => {
    const r = await notify("dry", { sms: true, dryRun: true });
    expect(r).toEqual({ slack: true, sms: true });
    expect(allDelivered(r)).toBe(true);
  });

  it("leaves sms null in dry-run when SMS was not requested", async () => {
    const r = await notify("dry", { dryRun: true });
    expect(r).toEqual({ slack: true, sms: null });
  });
});

describe("the CLI notify sends with", () => {
  it("is found in this checkout", async () => {
    // The negative control above proves a missing CLI is reported; this proves
    // the CLI is not missing. Without it, a path gone stale (as the shell
    // helpers' did) fails every real alert while the suite is green.
    const cli = barryCli();
    expect(cli).not.toBeNull();
    expect(existsSync(cli!.argv.at(-1)!)).toBe(true);
  });
});
