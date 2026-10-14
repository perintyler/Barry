// Resolve notifier credentials through the bound identity CLI so channels share its policy.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-076

import { installationRoot } from "@barry-rocks/sdk/services";
import { nodeTsArgv } from "@barry-rocks/sdk/internal/services";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The installation's CLI entry, which selects the active identity before notifying. */
export function barryCli(root = installationRoot()): { argv: string[] } | null {
  const entry = join(root, "cli", "src", "automation.ts");
  return existsSync(entry) ? { argv: nodeTsArgv(entry) } : null;
}

// Bound each channel send so one unavailable provider cannot hang the sampler.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-077
const CHANNEL_TIMEOUT_MS = 120_000;

export interface NotifyOptions {
  /** Escalate to SMS as well as Slack. */
  sms?: boolean;
  /** Print instead of sending. */
  dryRun?: boolean;
}

/** Per-channel delivery outcome. `sms` is null when SMS was not requested. */
export interface NotifyResult {
  slack: boolean;
  sms: boolean | null;
}

/** True when every channel that was ATTEMPTED succeeded. */
export function allDelivered(r: NotifyResult): boolean {
  return r.slack && r.sms !== false;
}

/** Send on one channel. Resolves false on timeout or non-zero exit. */
async function send(cli: { argv: string[] }, args: string[], channel: string): Promise<boolean> {
  try {
    // The message is an argv element, never part of a shell string: a metric
    // label containing a quote would otherwise be shell injection.
    await exec(cli.argv[0], [...cli.argv.slice(1), "notify", ...args], { timeout: CHANNEL_TIMEOUT_MS });
    return true;
  } catch (err) {
    process.stderr.write(
      `notify failed (${channel}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

// Record delivery attempts separately from firing state so failed sends remain diagnosable.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-078
export async function notify(message: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
  if (opts.dryRun) {
    process.stdout.write(`[dry-run] ${message}\n`);
    return { slack: true, sms: opts.sms ? true : null };
  }

  const cli = barryCli();
  if (!cli) {
    process.stderr.write(`notify: no barry CLI under ${installationRoot()}; alert not sent: ${message}\n`);
    return { slack: false, sms: opts.sms ? false : null };
  }

  const [slack, sms] = await Promise.all([
    send(cli, ["--type", "system_alert", "--severity", "error", message], "slack"),
    opts.sms ? send(cli, ["--channel", "sms", "--type", "system_alert", "--severity", "error", message], "sms") : Promise.resolve(null),
  ]);

  return { slack, sms };
}
